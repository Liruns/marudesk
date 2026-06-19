import { check, passedCount } from './harness-kit.ts';
import { locatePatch } from '../shared/patch.ts';
import { lineAnchor, locateAnchorLine } from './agent/line-anchor.ts';

/**
 * Harness for the v6 §W1 edit matcher: the "A" layer (locatePatch's exact match +
 * whitespace/CRLF/blank-tolerant fuzzy fallback, with ambiguity refusal) AND the
 * "B" layer (per-line hash anchors: lineAnchor + locateAnchorLine's unique-line
 * resolution and stale/ambiguous rejection). Pure, so it runs standalone via
 * `npm run harness:patch-match`.
 */

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

/* ── hash anchors (B layer) ─────────────────────────────────────────────── */

/** Apply an anchored single-line/range edit the way patch.ts does. */
function appliedByAnchor(
  content: string,
  anchor: string,
  newString: string,
  endAnchor?: string,
): string | null {
  const start = locateAnchorLine(content, anchor);
  if (!start.ok) return null;
  let end = start.end;
  if (endAnchor) {
    const e = locateAnchorLine(content, endAnchor);
    if (!e.ok) return null;
    end = e.end;
  }
  return content.slice(0, start.start) + newString + content.slice(end);
}

{
  const a = lineAnchor('const b = 2;');
  const m = locateAnchorLine(file, a);
  check('anchor: a line hash resolves to its unique line span', m.ok);
  check(
    'anchor: replacing by hash swaps only that line',
    appliedByAnchor(file, a, 'const b = 20;') === 'const a = 1;\nconst b = 20;\nconst c = 3;\n',
  );
}

{
  // CRLF tolerance: the anchor is computed with the trailing \r stripped, so the
  // SAME hash a model saw from an LF read resolves a CRLF line — and the byte span
  // covers the line content without the line ending (preserved on splice).
  const crlf = 'one\r\ntwo\r\nthree\r\n';
  const a = lineAnchor('two');
  check('anchor: CRLF line resolves by the CR-stripped hash', locateAnchorLine(crlf, a).ok);
  check(
    'anchor: CRLF replacement preserves the line ending',
    appliedByAnchor(crlf, a, 'TWO') === 'one\r\nTWO\r\nthree\r\n',
  );
}

{
  // Range edit: anchor..endAnchor spans the inclusive block of lines.
  const block = 'h1\nh2\nh3\nh4\n';
  const out = appliedByAnchor(block, lineAnchor('h2'), 'X\nY', lineAnchor('h3'));
  check('anchor: endAnchor spans the inclusive line range', out === 'h1\nX\nY\nh4\n');
}

{
  // Stale anchor: the line changed since the read, so its old hash no longer
  // resolves → not-found (the matcher's stale-anchor rejection).
  const m = locateAnchorLine(file, lineAnchor('const b = 999;'));
  check('anchor: a hash for a since-changed line is not-found (stale)', !m.ok && m.reason === 'not-found');
}

{
  // Two identical lines share a hash → ambiguous, so an anchor can't silently
  // target the wrong one (the caller falls back to oldString / endAnchor).
  const dup = 'x();\ny();\nx();\n';
  const m = locateAnchorLine(dup, lineAnchor('x();'));
  check('anchor: a hash matching two identical lines is ambiguous', !m.ok && m.reason === 'ambiguous');
}

console.log(`\n${passedCount()} checks passed`);
