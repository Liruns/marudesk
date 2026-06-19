import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Resource } from '../../shared/work-os';
import { check, passedCount } from '../harness-kit';
import {
  parseInput,
  extractArtifacts,
  resolveOutputs,
  stripJsonFences,
  firstJsonObject,
  runTask,
} from './run-task';

/**
 * Harness for the pure helpers behind {@link runTask} (electron/agent/run-task.ts —
 * the Work-OS `workos:run-task` flow). Sibling to workos-apply.harness.ts, which
 * already covers applyTaskPatch end-to-end; this one exercises the OTHER, untested
 * surface: payload validation (parseInput), the prose-tolerant JSON scanner
 * (firstJsonObject), artifact extraction (extractArtifacts), the security-critical
 * artifact→Resource resolution against a REAL temp workspace (resolveOutputs), the
 * fence stripper (stripJsonFences), and runTask's provider-free early returns.
 *
 * Pure/IO-only — no AI provider is reached — so it runs headless via
 * `npm run harness:run-task`.
 */

/** Map a resolved file:// Resource back to a workspace-relative POSIX path. */
function relOf(root: string, res: Resource): string {
  return path.relative(root, fileURLToPath(res.uri)).replace(/\\/g, '/');
}

function testParseInput(): void {
  check('parseInput: non-object → null', parseInput('nope') === null);
  check('parseInput: null → null', parseInput(null) === null);
  check('parseInput: missing taskId → null', parseInput({ title: 't' }) === null);
  check('parseInput: missing title → null', parseInput({ taskId: 't' }) === null);

  const minimal = parseInput({ taskId: 't1', title: 'Do it' });
  check('parseInput: a valid minimal payload normalizes', minimal !== null);
  check('parseInput: intent defaults to ""', minimal?.intent === '');
  check('parseInput: goal defaults to ""', minimal?.goal === '');
  check('parseInput: acceptance defaults to []', Array.isArray(minimal?.acceptance) && minimal?.acceptance.length === 0);

  const mixed = parseInput({
    taskId: 't2',
    title: 'T',
    acceptance: ['keep me', 7, null, 'also me', { x: 1 }],
  });
  check(
    'parseInput: acceptance keeps only the string members',
    !!mixed && mixed.acceptance.length === 2 && mixed.acceptance[0] === 'keep me' && mixed.acceptance[1] === 'also me',
  );
}

function testFirstJsonObject(): void {
  const bare = firstJsonObject('{"a":1,"b":"two"}');
  check('firstJsonObject: a bare object parses', !!bare && bare.a === 1 && bare.b === 'two');

  const prosed = firstJsonObject('Here is the result you asked for:\n{"ok":true}\nThanks!');
  check('firstJsonObject: an object preceded by prose parses', !!prosed && prosed.ok === true);

  // A brace INSIDE a JSON string value must not throw off depth tracking — the
  // object closes at its real terminator, not the brace in the string.
  const braceInStr = firstJsonObject('{"note":"a } brace { inside","done":true}');
  check(
    'firstJsonObject: a brace inside a string value does not break depth tracking',
    !!braceInStr && braceInStr.note === 'a } brace { inside' && braceInStr.done === true,
  );

  check('firstJsonObject: malformed JSON → null', firstJsonObject('{"a": }') === null);
  check('firstJsonObject: text with no brace → null', firstJsonObject('nothing to see here') === null);
  // Opened but never balanced: the scanner must fall through to null, never a partial slice.
  check('firstJsonObject: an unterminated object → null', firstJsonObject('prefix {"a":1 and never closes') === null);
}

function testExtractArtifacts(): void {
  const fenced = extractArtifacts(
    'Report text.\n```json\n{"artifacts":[{"path":"src/a.ts","label":"the main file"}]}\n```',
  );
  check(
    'extractArtifacts: a fenced json block yields its artifacts',
    fenced.length === 1 && fenced[0].path === 'src/a.ts' && fenced[0].label === 'the main file',
  );

  const unfenced = extractArtifacts('{"artifacts":[{"path":"plain.ts"}]}');
  check(
    'extractArtifacts: an unfenced json object is scanned (fallback)',
    unfenced.length === 1 && unfenced[0].path === 'plain.ts' && unfenced[0].label === undefined,
  );

  // Several fenced blocks: the FIRST with a valid artifacts array wins.
  const multi = extractArtifacts(
    '```json\n{"notArtifacts":[1,2,3]}\n```\n```json\n{"artifacts":[{"path":"winner.ts"}]}\n```\n```json\n{"artifacts":[{"path":"loser.ts"}]}\n```',
  );
  check(
    'extractArtifacts: first fenced block with a valid artifacts array wins',
    multi.length === 1 && multi[0].path === 'winner.ts',
  );

  const cleaned = extractArtifacts(
    '```json\n{"artifacts":[{"path":"keep.ts"},{"path":""},{"path":"   "},{"path":"   trimmed.ts   "},42,null,"str",{"label":"no path"}]}\n```',
  );
  check(
    'extractArtifacts: drops missing/empty paths, skips non-object items, trims paths',
    cleaned.length === 2 && cleaned[0].path === 'keep.ts' && cleaned[1].path === 'trimmed.ts',
  );

  check('extractArtifacts: returns [] when nothing matches', extractArtifacts('no json at all here').length === 0);
}

function testResolveOutputs(workspace: string): void {
  check('resolveOutputs: null root → []', resolveOutputs(null, [{ path: 'real.txt' }]).length === 0);

  // ── one real file inside root → ONE Resource ────────────────────────────────
  writeFileSync(path.join(workspace, 'real.txt'), 'hello');
  const one = resolveOutputs(workspace, [{ path: 'real.txt', label: 'My File' }]);
  check('resolveOutputs: a real in-root file resolves to ONE Resource', one.length === 1);
  check('resolveOutputs: kind is "code"', one[0]?.kind === 'code');
  check('resolveOutputs: uri is a file:// URL', one[0]?.uri.startsWith('file://') === true);
  check('resolveOutputs: uri points at the real file', relOf(workspace, one[0]) === 'real.txt');
  check('resolveOutputs: label uses artifact.label when present', one[0]?.label === 'My File');

  const noLabel = resolveOutputs(workspace, [{ path: 'real.txt' }]);
  check('resolveOutputs: label falls back to artifact.path', noLabel[0]?.label === 'real.txt');

  // ── traversal / absolute paths are rejected ────────────────────────────────
  writeFileSync(path.join(path.dirname(workspace), 'escaped.txt'), 'outside');
  check(
    'resolveOutputs: a "../" path that escapes root is rejected',
    resolveOutputs(workspace, [{ path: '../escaped.txt' }]).length === 0,
  );
  check(
    'resolveOutputs: an absolute path is rejected',
    resolveOutputs(workspace, [{ path: path.join(workspace, 'real.txt') }]).length === 0,
  );

  // ── directories, missing files are skipped ─────────────────────────────────
  mkdirSync(path.join(workspace, 'adir'));
  check('resolveOutputs: a directory (not a file) is skipped', resolveOutputs(workspace, [{ path: 'adir' }]).length === 0);
  check('resolveOutputs: a missing file is skipped', resolveOutputs(workspace, [{ path: 'ghost.txt' }]).length === 0);

  // ── duplicate paths dedupe to one ──────────────────────────────────────────
  const dup = resolveOutputs(workspace, [{ path: 'real.txt' }, { path: 'real.txt' }, { path: './real.txt' }]);
  check('resolveOutputs: duplicate paths dedupe to one Resource', dup.length === 1);

  // ── MAX_OUTPUTS cap (8) ────────────────────────────────────────────────────
  const many: { path: string }[] = [];
  for (let i = 0; i < 12; i += 1) {
    const name = `cap-${i}.txt`;
    writeFileSync(path.join(workspace, name), String(i));
    many.push({ path: name });
  }
  check('resolveOutputs: more than MAX_OUTPUTS distinct files are capped at 8', resolveOutputs(workspace, many).length === 8);

  // ── symlink rejection (best-effort: Windows often EPERM without Dev Mode) ───
  let symlinkCreated = false;
  const linkPath = path.join(workspace, 'link.txt');
  try {
    symlinkSync(path.join(workspace, 'real.txt'), linkPath, 'file');
    symlinkCreated = true;
  } catch {
    console.log('  (skip) symlink rejection: could not create a symlink (EPERM — no Developer Mode)');
  }
  if (symlinkCreated) {
    check('resolveOutputs: a symlink is rejected', resolveOutputs(workspace, [{ path: 'link.txt' }]).length === 0);
  }
}

function testStripJsonFences(): void {
  const text = 'Here is what I found.\n\n```json\n{"artifacts":[{"path":"x.ts"}]}\n```';
  check('stripJsonFences: removes the fenced json block and trims', stripJsonFences(text) === 'Here is what I found.');
  check('stripJsonFences: leaves ordinary prose intact', stripJsonFences('just prose, no fence') === 'just prose, no fence');
}

async function testRunTaskEarlyReturns(): Promise<void> {
  const invalid = await runTask('nope');
  check('runTask: invalid payload → ok:false', invalid.ok === false);
  check(
    'runTask: invalid payload reason is "Invalid task payload."',
    invalid.ok === false && invalid.reason === 'Invalid task payload.',
  );

  // Valid shape but no title AND no intent → early return before provider resolution.
  const empty = await runTask({ taskId: 't', title: '', intent: '' });
  check('runTask: no title or intent → ok:false (before any provider resolution)', empty.ok === false);
}

async function main(): Promise<void> {
  // workspace is a child dir so a "../escaped.txt" fixture can live OUTSIDE it.
  const base = mkdtempSync(path.join(tmpdir(), 'run-task-harness-'));
  const workspace = path.join(base, 'ws');
  mkdirSync(workspace);
  try {
    testParseInput();
    testFirstJsonObject();
    testExtractArtifacts();
    testResolveOutputs(workspace);
    testStripJsonFences();
    await testRunTaskEarlyReturns();

    console.log(`\nrun-task harness: ${passedCount()} assertions passed`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('run-task harness FAILED:', err);
  process.exitCode = 1;
});
