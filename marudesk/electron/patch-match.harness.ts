import { check, passedCount } from './harness-kit.ts';
import { adjustNewIndent, locatePatch } from '../shared/patch.ts';
import { lineAnchor, locateAnchorLine, resolveByLineAndHash } from './agent/line-anchor.ts';
import {
  AnchorMismatchError,
  batchValidateAnchors,
  resolveEditSpan,
  resolveNewString,
  resolveSequentialEdits,
  type ValidatedOp,
} from './agent/edit-span.ts';
import { autocorrectNewString, stripReadViewPrefixes } from './agent/edit-normalize.ts';

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

/* ── line+hash hint (EDIT-1: duplicate-line disambiguation) ──────────────── */

{
  // Two identical lines: the 1-based line hint picks the intended one instead of
  // failing as ambiguous (what a bare anchor does).
  const dup = 'x();\ny();\nx();\n';
  const a = lineAnchor('x();');
  const s1 = resolveByLineAndHash(dup, 1, a);
  const s3 = resolveByLineAndHash(dup, 3, a);
  check('line+hash: hint=1 resolves the FIRST of two identical lines', s1.ok && s1.start === 0);
  check('line+hash: hint=3 resolves the SECOND of two identical lines', s3.ok && s3.start === 'x();\ny();\n'.length);
}

{
  // A hint pointing at the wrong line (its hash doesn't match) falls back to the
  // unique whole-file scan — which here is ambiguous, so it's still refused.
  const dup = 'x();\ny();\nx();\n';
  const bad = resolveByLineAndHash(dup, 2, lineAnchor('x();'));
  check('line+hash: wrong hint falls back to the scan (ambiguous here)', !bad.ok && bad.reason === 'ambiguous');
}

{
  // An out-of-range hint also falls back; on a unique line the scan still resolves.
  const uniq = 'a\nb\nc\n';
  const s = resolveByLineAndHash(uniq, 99, lineAnchor('b'));
  check('line+hash: out-of-range hint falls back to the unique scan', s.ok && s.start === 'a\n'.length);
}

{
  // A stale hash (line changed since the read) is not-found even with a hint.
  const s = resolveByLineAndHash('a\nb\nc\n', 2, lineAnchor('B-changed'));
  check('line+hash: a stale hash is not-found even with a line hint', !s.ok && s.reason === 'not-found');
}

{
  // resolveEditSpan threads anchorLine through, so an anchored edit on a duplicate
  // line now resolves (was ambiguous), and without the hint it stays ambiguous.
  const dup = 'x();\ny();\nx();\n';
  const withHint = resolveEditSpan(dup, { path: 'f', oldString: '', newString: 'z();', anchor: lineAnchor('x();'), anchorLine: 3 });
  check('resolveEditSpan: anchorLine disambiguates a duplicate line', withHint.ok && withHint.start === 'x();\ny();\n'.length);
  const noHint = resolveEditSpan(dup, { path: 'f', oldString: '', newString: 'z();', anchor: lineAnchor('x();') });
  check('resolveEditSpan: a bare anchor on duplicate lines is refused', !noHint.ok);
}

/* ── sequential composition (EDIT-1: same-file multi-edit, §C bug fix) ────── */

{
  // Two edits to DIFFERENT regions of one file must BOTH land. (The bug: each op
  // computed a full-file replacement from the original and the last write won.)
  const file = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';
  const r = resolveSequentialEdits(file, [
    { path: 'f', oldString: 'const a = 1;', newString: 'const a = 10;' },
    { path: 'f', oldString: 'const c = 3;', newString: 'const c = 30;' },
  ]);
  check('sequential: two independent same-file edits BOTH apply', r.ok && r.next === 'const a = 10;\nconst b = 2;\nconst c = 30;\n');
}

{
  // Independent edits compose regardless of op order.
  const file = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';
  const r = resolveSequentialEdits(file, [
    { path: 'f', oldString: 'const c = 3;', newString: 'const c = 30;' },
    { path: 'f', oldString: 'const a = 1;', newString: 'const a = 10;' },
  ]);
  check('sequential: independent edits are order-independent', r.ok && r.next === 'const a = 10;\nconst b = 2;\nconst c = 30;\n');
}

{
  // A later op may edit text an earlier op produced (it sees the running content).
  const r = resolveSequentialEdits('foo\n', [
    { path: 'f', oldString: 'foo', newString: 'bar' },
    { path: 'f', oldString: 'bar', newString: 'baz' },
  ]);
  check('sequential: a later op chains onto the earlier op result', r.ok && r.next === 'baz\n');
}

{
  // A later op targeting text an earlier op REMOVED fails cleanly (reports opIndex),
  // rather than silently overwriting — the safe behaviour for a genuine conflict.
  const r = resolveSequentialEdits('foo\nqux\n', [
    { path: 'f', oldString: 'foo\nqux\n', newString: 'X\n' },
    { path: 'f', oldString: 'qux', newString: 'QUX' },
  ]);
  check('sequential: an op hitting removed text fails at its opIndex', !r.ok && r.opIndex === 1);
}

/* ── batch anchor validation + remap (EDIT-1 follow-up §4-5) ─────────────── */

/** Run batchValidateAnchors and return the thrown AnchorMismatchError, or null. */
function batchError(entries: readonly ValidatedOp[]): AnchorMismatchError | null {
  try {
    batchValidateAnchors(entries);
    return null;
  } catch (err) {
    return err instanceof AnchorMismatchError ? err : null;
  }
}

{
  // Every op resolves → no throw (returns normally).
  const file = 'const a = 1;\nconst b = 2;\n';
  const err = batchError([
    { op: { path: 'f', oldString: '', newString: 'A', anchor: lineAnchor('const a = 1;') }, current: file },
    { op: { path: 'f', oldString: 'const b = 2;', newString: 'B' }, current: file },
  ]);
  check('batch: all-resolving ops pass without an error', err === null);
}

{
  // Creates (empty oldString, no anchor) are skipped — they never fail validation.
  const err = batchError([{ op: { path: 'new.ts', oldString: '', newString: 'hi' }, current: '' }]);
  check('batch: a create op is skipped (no failure)', err === null);
}

{
  // One stale anchor among several ops → ONE error listing EVERY failing op (here
  // both: a stale anchor and a vanished oldString), with their paths.
  const file = 'a\nb\nc\n';
  const err = batchError([
    { op: { path: 'x.ts', oldString: '', newString: 'A', anchor: lineAnchor('gone') }, current: file },
    { op: { path: 'y.ts', oldString: 'absent', newString: 'Z' }, current: file },
    { op: { path: 'x.ts', oldString: 'b', newString: 'B' }, current: file }, // resolves — not reported
  ]);
  check('batch: collects every failing op (not just the first)', err !== null && err.failures.length === 2);
  check('batch: failure carries the op path', err !== null && err.failures[0].path === 'x.ts' && err.failures[1].path === 'y.ts');
  check('batch: a resolving op is NOT in the failures', err !== null && !err.failures.some((f) => f.reason.includes('multiple')));
}

{
  // Remap: a stale anchor whose op carried anchorLine maps to the FRESH anchor of
  // the line currently AT that line number — so the model can re-anchor directly.
  // (Original line 2 was 'two'; the file now has 'TWO-EDITED' there.)
  const after = 'one\nTWO-EDITED\nthree\n';
  const staleAnchor = lineAnchor('two'); // hash the model read, now stale on disk
  const err = batchError([
    { op: { path: 'f', oldString: '', newString: 'X', anchor: staleAnchor, anchorLine: 2 }, current: after },
  ]);
  check('batch: a stale anchor with anchorLine produces a remap entry', err !== null && err.remaps.has(staleAnchor));
  check(
    'batch: the remap targets the FRESH anchor of the intended line',
    err !== null && err.remaps.get(staleAnchor) === lineAnchor('TWO-EDITED'),
  );
}

{
  // No anchorLine hint → the stale anchor can't be remapped (still reported as a
  // failure, just without a remap entry).
  const after = 'one\nTWO-EDITED\nthree\n';
  const staleAnchor = lineAnchor('two');
  const err = batchError([
    { op: { path: 'f', oldString: '', newString: 'X', anchor: staleAnchor }, current: after },
  ]);
  check('batch: without anchorLine there is a failure but no remap', err !== null && err.failures.length === 1 && err.remaps.size === 0);
}

{
  // endAnchor + endAnchorLine also remaps when its hash went stale.
  const after = 'h1\nH2-EDITED\nH3-EDITED\nh4\n';
  const staleStart = lineAnchor('h2');
  const staleEnd = lineAnchor('h3');
  const err = batchError([
    {
      op: { path: 'f', oldString: '', newString: 'X', anchor: staleStart, anchorLine: 2, endAnchor: staleEnd, endAnchorLine: 3 },
      current: after,
    },
  ]);
  check('batch: endAnchor with endAnchorLine remaps too', err !== null && err.remaps.get(staleEnd) === lineAnchor('H3-EDITED'));
}

/* ── item 2: Unicode/typography folding in the fuzzy locator ─────────────── */

{
  // The file has a straight-quoted/hyphenated line; the model pasted the SAME line
  // with a curly apostrophe and an en-dash (web/markdown paste). Exact indexOf and
  // a CR+trim fuzzy both miss on the raw bytes — only typography folding finds it.
  const file = "const msg = 'it’s a 3–4 split';\nconst x = 1;\n";
  const model = "const msg = 'it's a 3-4 split';"; // straight quote + hyphen
  const m = locatePatch(file, model);
  check('unicode: a curly-quote/en-dash block matches via folding', m.ok && m.fuzzy === true);
  // The WRITTEN bytes come from the file's real span — the replacement keeps the
  // file's own characters everywhere outside the spliced range.
  const out = m.ok ? file.slice(0, m.start) + 'REPLACED' + file.slice(m.end) : null;
  check('unicode: replacement splices the real file bytes', out === 'REPLACED\nconst x = 1;\n');
}

{
  // NBSP + zero-width chars in the file fold to a plain space / nothing for matching.
  const file = 'const a​ = 1;\nconst b = 2;\n';
  const m = locatePatch(file, 'const a = 1;');
  check('unicode: NBSP + zero-width fold for the match', m.ok && m.fuzzy === true);
  // The untouched second line keeps its exact bytes; the matched span is replaced.
  const out = m.ok ? file.slice(0, m.start) + 'X' + file.slice(m.end) : null;
  check('unicode: only the matched span is rewritten (real bytes elsewhere)', out === 'X\nconst b = 2;\n');
}

/* ── item 3: indentation-delta adjustment after a fuzzy match ─────────────── */

{
  // The file indents the block 4 spaces; the model wrote oldString + newString at 0.
  // The fuzzy match lands the (real) 4-space block; the indent delta is applied to
  // newString so the written result keeps the file's true indentation.
  const oldString = 'doThing();\ndoOther();';
  const actual = '    doThing();\n    doOther();';
  const out = adjustNewIndent(oldString, actual, 'doThing();\ndoNew();');
  check('indent-delta: a uniform +4 shift is applied to newString', out === '    doThing();\n    doNew();');
}

{
  // A pure re-indentation (model deliberately changes indent, same trimmed text)
  // is left verbatim — the model's indentation IS the intent.
  const oldString = '    a();\n    b();';
  const out = adjustNewIndent(oldString, oldString, '  a();\n  b();');
  check('indent-delta: a pure re-indentation is kept verbatim', out === '  a();\n  b();');
}

{
  // No uniform delta (mixed shifts) → newString untouched, never a corrupting guess.
  const oldString = 'a();\n  b();';
  const actual = '    a();\n    b();'; // line1 +4, line2 +2 → not uniform
  const out = adjustNewIndent(oldString, actual, 'a();\n  b();');
  check('indent-delta: a non-uniform shift leaves newString unchanged', out === 'a();\n  b();');
}

{
  // End-to-end via resolveNewString: a fuzzy verbatim edit where the model's
  // multi-line oldString is written at 0 indent but the file's real block is at 8.
  // The whole block isn't a verbatim substring, so the match is fuzzy; the +8 delta
  // is applied to newString, and the spliced span is the file's real bytes.
  const file = 'fn() {\n        a();\n        b();\n}\n';
  const op = { path: 'f', oldString: 'a();\nb();', newString: 'a();\nc();' };
  const span = resolveEditSpan(file, op);
  check('indent-delta: resolveEditSpan reports a fuzzy match', span.ok && span.fuzzy === true);
  const ns = span.ok ? resolveNewString(file, op, span) : null;
  check('indent-delta: resolveNewString re-indents to 8 spaces', ns === '        a();\n        c();');
  const r = resolveSequentialEdits(file, [op]);
  check('indent-delta: the written file keeps real indentation', r.ok && r.next === 'fn() {\n        a();\n        c();\n}\n');
}

/* ── item 4: 3-stage newString autocorrect (unambiguous mappings only) ────── */

{
  // Collapsed multiline: the model wrote the two-line block on ONE line; the matched
  // original is two lines whose whitespace-stripped content equals the collapse →
  // expand back to the real two lines.
  const actual = 'const a = 1;\nconst b = 2;';
  const out = autocorrectNewString(actual, 'const a = 1;const b = 2;');
  check('autocorrect: a collapsed multiline newString is expanded back', out === 'const a = 1;\nconst b = 2;');
}

{
  // A genuine single-line replacement (no canonical match to the original block) is
  // left untouched — the collapse pass must not fire on unrelated content.
  const actual = 'const a = 1;\nconst b = 2;';
  const out = autocorrectNewString(actual, 'const total = a + b;');
  check('autocorrect: an unrelated single-line newString is left verbatim', out === 'const total = a + b;');
}

{
  // Indent restore for a 1:1 mapping: the model dropped the leading indent on a line
  // whose original had it (and the trimmed text differs) → re-apply the indent.
  const actual = '    if (x) {\n        run();\n    }';
  const newString = '    if (x) {\nrun2();\n    }';
  const out = autocorrectNewString(actual, newString);
  check('autocorrect: a de-indented paired line gets its indent restored', out === '    if (x) {\n        run2();\n    }');
}

/* ── item 5: read-view prefix / diff-marker echo strip ───────────────────── */

{
  // The model echoed the anchored read view ("N <hash>\t") on EVERY line → strip it.
  const a1 = lineAnchor('const a = 1;');
  const a2 = lineAnchor('const b = 2;');
  const echoed = [`  1 ${a1}\tconst a = 1;`, `  2 ${a2}\tconst b = 2;`];
  const out = stripReadViewPrefixes(echoed);
  check('prefix-strip: an echoed read-view prefix is removed on all lines', out.join('\n') === 'const a = 1;\nconst b = 2;');
}

{
  // A single real line that merely starts with a number+tab (below the >50% bar with
  // other clean lines) is NOT stripped — false positives stay ~0.
  const lines = ['42\tnormal code line', 'const b = 2;', 'const c = 3;'];
  const out = stripReadViewPrefixes(lines);
  check('prefix-strip: a lone number+tab line is kept (under threshold)', out === lines);
}

{
  // A unified-diff '+' on >50% of lines is stripped; '++' (real code) is preserved.
  const lines = ['+const a = 1;', '+const b = 2;', '+const c = 3;'];
  const out = stripReadViewPrefixes(lines);
  check('prefix-strip: a dominant diff-plus marker is removed', out.join('\n') === 'const a = 1;\nconst b = 2;\nconst c = 3;');
  const code = ['a++;', 'b++;'];
  check('prefix-strip: "++" code is never treated as a diff marker', stripReadViewPrefixes(code) === code);
}

{
  // End-to-end: a verbatim edit whose newString echoed the read-view prefix writes
  // the CLEAN text (prefix stripped), never the display form into the file.
  const a = lineAnchor('let v = 0;');
  const file = 'let v = 0;\nconst k = 1;\n';
  const op = { path: 'f', oldString: 'let v = 0;', newString: `  1 ${a}\tlet v = 99;` };
  const r = resolveSequentialEdits(file, [op]);
  check('prefix-strip: the written file drops an echoed read-view prefix', r.ok && r.next === 'let v = 99;\nconst k = 1;\n');
}

{
  // A normal exact-match multi-line edit (correct content + indentation) must pass
  // through the autocorrect untouched — the passes only fire on drift, never on a
  // clean edit, so legitimate replacements are never rewritten.
  const file = 'function f() {\n  const a = 1;\n  return a;\n}\n';
  const op = { path: 'f', oldString: '  const a = 1;\n  return a;', newString: '  const a = 2;\n  return a + 1;' };
  const r = resolveSequentialEdits(file, [op]);
  check(
    'autocorrect: a clean exact multi-line edit is written verbatim',
    r.ok && r.next === 'function f() {\n  const a = 2;\n  return a + 1;\n}\n',
  );
}

/* ── byte-preservation invariant (all normalization is locate-only) ──────── */

{
  // A CRLF file edited via a fuzzy (typography-folded) match keeps its \r\n endings
  // and every byte outside the spliced span — normalization never reaches the write.
  const crlf = "x = '‘q’';\r\ny = 2;\r\n"; // line 1 has curly quotes
  const op = { path: 'f', oldString: "x = ''q'';", newString: "x = 'Q';" };
  // (The model's straight-quote oldString folds to match the curly-quote line.)
  const r = resolveSequentialEdits(crlf, [op]);
  check('bytes: a fuzzy edit preserves the file CRLF + untouched bytes', r.ok && r.next === "x = 'Q';\r\ny = 2;\r\n");
}

console.log(`\n${passedCount()} checks passed`);
