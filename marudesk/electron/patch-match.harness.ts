import assert from 'node:assert/strict';
import { locatePatch } from '../shared/patch.ts';

/**
 * Harness for the v6 §W1 "A" layer: locatePatch's exact match + whitespace/CRLF/
 * blank-tolerant fuzzy fallback (and its ambiguity-refusal safety). Pure, so it
 * runs standalone via `npm run harness:patch-match`.
 */

let passed = 0;
function check(label: string, cond: boolean): void {
  assert.ok(cond, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

/** Apply a successful match the way patch.ts does, to verify the replaced span. */
function applied(content: string, oldString: string, newString: string): string | null {
  const m = locatePatch(content, oldString);
  if (!m.ok) return null;
  return content.slice(0, m.start) + newString + content.slice(m.end);
}

/* ── exact path ─────────────────────────────────────────────────────────── */

const file = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';

{
  const m = locatePatch(file, 'const b = 2;');
  check('exact: unique match found', m.ok && m.fuzzy === false);
  check('exact: replacement is correct', applied(file, 'const b = 2;', 'const b = 20;') === 'const a = 1;\nconst b = 20;\nconst c = 3;\n');
}

{
  const dup = 'x();\ny();\nx();\n';
  const m = locatePatch(dup, 'x();');
  check('exact: duplicate match is refused as ambiguous', !m.ok && m.reason === 'ambiguous');
}

{
  const m = locatePatch(file, 'const z = 9;');
  check('miss: absent string is not-found', !m.ok && m.reason === 'not-found');
}

/* ── fuzzy fallback (A layer) ───────────────────────────────────────────── */

{
  // File uses CRLF; the model's oldString is a multi-line LF block (so it isn't a
  // plain substring — this genuinely exercises the fuzzy path, not exact indexOf).
  const crlf = 'line one\r\ntarget a\r\ntarget b\r\nline four\r\n';
  const m = locatePatch(crlf, 'target a\ntarget b');
  check('fuzzy: matches a multi-line block across CRLF/LF difference', m.ok && m.fuzzy === true);
  check(
    'fuzzy: CRLF replacement preserves the trailing \\r\\n',
    applied(crlf, 'target a\ntarget b', 'MERGED') === 'line one\r\nMERGED\r\nline four\r\n',
  );
}

{
  // File indents the block with 4 spaces; the model wrote 2. The inter-line indent
  // differs, so it's not a substring — only the fuzzy line-trim match finds it.
  const indented = 'if (x) {\n    doThing();\n    doOther();\n}\n';
  const m = locatePatch(indented, '  doThing();\n  doOther();');
  check('fuzzy: matches a block across indentation drift', m.ok && m.fuzzy === true);
}

{
  // The model's oldString carries an extra trailing blank line the file lacks, so
  // exact indexOf misses and the fuzzy layer must tolerate it.
  const block = 'a\nb\nc\nd\n';
  const m = locatePatch(block, 'b\nc\n\n');
  check('fuzzy: tolerates an extra trailing blank line in oldString', m.ok && m.fuzzy === true);
  check(
    'fuzzy: multi-line replacement spans only the real block',
    applied(block, 'b\nc\n\n', 'B\nC') === 'a\nB\nC\nd\n',
  );
}

{
  // Both occurrences differ in indentation, so exact misses both; the normalized
  // block then matches two places → must refuse rather than guess (safety).
  const ambig = 'foo\n  bar\nbaz\nfoo\n   bar\nqux\n';
  const m = locatePatch(ambig, 'foo\nbar');
  check('fuzzy: ambiguous normalized block is refused', !m.ok && m.reason === 'ambiguous');
}

console.log(`\n${passed} checks passed`);
