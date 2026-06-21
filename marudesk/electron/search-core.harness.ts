import assert from 'node:assert/strict';
import type { SearchOptions } from '../shared/search';
import {
  buildPreview,
  byteToCharIndex,
  compilePathFilter,
  globToRegExp,
  makeLineMatcher,
  parseGlobs,
  resolveSearchRoot,
} from './search-core';

/**
 * Pure-helper checks for the content-search core. Run with:
 *   node --experimental-strip-types electron/search-core.harness.ts
 * (no Electron boot — search-core only touches node:Buffer + shared types).
 */

let passed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

function opts(over: Partial<SearchOptions> = {}): SearchOptions {
  return {
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    includes: '',
    excludes: '',
    ...over,
  };
}

check('parseGlobs splits on commas and newlines, trims, drops blanks', () => {
  assert.deepEqual(parseGlobs('*.ts, src/**\n , *.tsx'), [
    '*.ts',
    'src/**',
    '*.tsx',
  ]);
  assert.deepEqual(parseGlobs('   '), []);
});

check('globToRegExp: bare pattern matches basename at any depth', () => {
  const re = globToRegExp('*.ts');
  assert.equal(re.test('a.ts'), true);
  assert.equal(re.test('src/deep/a.ts'), true);
  assert.equal(re.test('a.tsx'), false);
});

check('globToRegExp: pattern with slash is anchored to root', () => {
  const re = globToRegExp('src/**');
  assert.equal(re.test('src/a.ts'), true);
  assert.equal(re.test('src/deep/a.ts'), true);
  assert.equal(re.test('other/src/a.ts'), false);
});

check('globToRegExp: brace alternation', () => {
  const re = globToRegExp('*.{ts,tsx}');
  assert.equal(re.test('a.ts'), true);
  assert.equal(re.test('a.tsx'), true);
  assert.equal(re.test('a.js'), false);
});

check('globToRegExp: single * stays within a segment', () => {
  const re = globToRegExp('src/*.ts');
  assert.equal(re.test('src/a.ts'), true);
  assert.equal(re.test('src/deep/a.ts'), false);
});

check('globToRegExp: trailing-slash dir pattern matches the subtree', () => {
  const re = globToRegExp('dist/');
  assert.equal(re.test('dist'), true);
  assert.equal(re.test('dist/a.js'), true);
  assert.equal(re.test('dist/deep/a.js'), true);
  assert.equal(re.test('distant/a.js'), false);
});

check('compilePathFilter: includes restrict, excludes win', () => {
  const f = compilePathFilter(['*.ts'], ['*.test.ts']);
  assert.equal(f('src/a.ts'), true);
  assert.equal(f('src/a.test.ts'), false);
  assert.equal(f('src/a.js'), false);
});

check('compilePathFilter: no includes means everything is in scope', () => {
  const f = compilePathFilter([], ['*.log']);
  assert.equal(f('src/a.ts'), true);
  assert.equal(f('debug.log'), false);
});

check('makeLineMatcher: substring finds every occurrence (case-insensitive)', () => {
  const m = makeLineMatcher('ab', opts());
  assert.deepEqual(m('ab x AB y aB'), [
    { start: 0, end: 2 },
    { start: 5, end: 7 },
    { start: 10, end: 12 },
  ]);
});

check('makeLineMatcher: case-sensitive substring', () => {
  const m = makeLineMatcher('AB', opts({ caseSensitive: true }));
  assert.deepEqual(m('ab AB'), [{ start: 3, end: 5 }]);
});

check('makeLineMatcher: regex global, multiple matches', () => {
  const m = makeLineMatcher('a+', opts({ regex: true }));
  assert.deepEqual(m('a aa aaa'), [
    { start: 0, end: 1 },
    { start: 2, end: 4 },
    { start: 5, end: 8 },
  ]);
});

check('makeLineMatcher: zero-width regex does not loop forever', () => {
  const m = makeLineMatcher('x*', opts({ regex: true }));
  // Just assert it terminates and returns an array.
  assert.equal(Array.isArray(m('abc')), true);
});

check('makeLineMatcher: whole word', () => {
  const m = makeLineMatcher('cat', opts({ wholeWord: true }));
  assert.deepEqual(m('cat category cat'), [
    { start: 0, end: 3 },
    { start: 13, end: 16 },
  ]);
});

check('byteToCharIndex: ascii is identity, multibyte converts', () => {
  assert.equal(byteToCharIndex('hello', 3), 3);
  // "café" → bytes c(1) a(1) f(1) é(2). Byte offset 5 is end (4 chars).
  assert.equal(byteToCharIndex('café!', 5), 4);
  assert.equal(byteToCharIndex('café!', 0), 0);
});

check('buildPreview: left-trims and re-bases ranges', () => {
  const { preview, ranges } = buildPreview('    const x = 1', [
    { start: 10, end: 11 },
  ], 400);
  assert.equal(preview, 'const x = 1');
  // 'x' was at index 10; after trimming 4 leading spaces it's at 6.
  assert.deepEqual(ranges, [{ start: 6, end: 7 }]);
});

check('buildPreview: clamps ranges past the cap', () => {
  const long = 'a'.repeat(10) + 'MATCH';
  const { preview, ranges } = buildPreview(long, [{ start: 10, end: 15 }], 12);
  assert.equal(preview.length, 12);
  // Range [10,15) clamps to [10,12).
  assert.deepEqual(ranges, [{ start: 10, end: 12 }]);
});

check('buildPreview: drops ranges entirely before the trim point', () => {
  const { ranges } = buildPreview('  ab', [{ start: 0, end: 1 }], 400);
  // The leading-space-only range disappears after trimming 2 spaces.
  assert.deepEqual(ranges, []);
});

check('resolveSearchRoot: omitted workspaceId uses the active root', () => {
  let activeCalls = 0;
  const root = resolveSearchRoot(
    undefined,
    () => {
      activeCalls++;
      return '/active/root';
    },
    () => {
      throw new Error('rootFor must not be consulted when workspaceId omitted');
    },
  );
  assert.equal(root, '/active/root');
  assert.equal(activeCalls, 1);
});

check('resolveSearchRoot: provided workspaceId scopes to THAT workspace root', () => {
  const roots: Record<string, string> = {
    'ws-active': '/active/root',
    'ws-bound': '/bound/root',
  };
  const root = resolveSearchRoot(
    'ws-bound',
    () => {
      throw new Error('active root must not be consulted when workspaceId given');
    },
    (id) => roots[id] ?? null,
  );
  // The bound workspace's root, NOT the active one — so listed results scope to
  // the same root the opened file refs resolve against (R14 regression).
  assert.equal(root, '/bound/root');
});

check('resolveSearchRoot: unknown provided workspaceId throws', () => {
  assert.throws(
    () =>
      resolveSearchRoot(
        'ws-missing',
        () => '/active/root',
        () => null,
      ),
    /workspace not found: ws-missing/,
  );
});

if (process.exitCode) {
  console.error(`\nsearch-core harness: FAILED`);
} else {
  console.log(`search-core harness: ${passed} checks passed`);
}
