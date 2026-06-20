import { check, passedCount } from '../harness-kit.ts';
import { relocateAnchorByContent } from './edit-span.ts';
import { lineAnchor } from './line-anchor.ts';
import {
  recordRead,
  snapshotLineContent,
  updateAfterWrite,
  clearReadTracker,
} from './read-tracker.ts';

/**
 * Harness for the zero-retry stale-anchor relocate (SECOND-PASS item 5). Pure +
 * dependency-free — runs standalone under `node --experimental-strip-types`.
 *
 * Covers the CONSERVATIVE content relocate (exact + unique only; never guesses)
 * and the read-tracker per-line snapshot round-trip (record, lookup, refresh on
 * write, clear). The whole point is that a relocate can ONLY ever land on a line
 * whose content the model actually saw and that is unique in the file — so edit
 * safety is preserved.
 */

const FILE = [
  'import { a } from "./a";',
  'function foo() {',
  '  return a + 1;',
  '}',
  '',
  'function bar() {',
  '  return 2;',
  '}',
].join('\n');

/* ── relocateAnchorByContent: success on an exact, unique match ────────────── */
{
  // The model anchored to `  return a + 1;`. The file then shifted (a line was
  // inserted at the top), so the old anchor/line are stale — but the line CONTENT
  // is still uniquely present, so we relocate WITHOUT a round-trip.
  const shifted = `// new top comment\n${FILE}`;
  const reloc = relocateAnchorByContent(shifted, '  return a + 1;');
  check('exact unique line relocates', reloc.ok);
  if (reloc.ok) {
    check('relocated to the new (shifted) line number', reloc.line === 4);
    check('fresh anchor matches the line hash', reloc.anchor === lineAnchor('  return a + 1;'));
    // The returned span must cover exactly the relocated line's text.
    check('span covers the line content', shifted.slice(reloc.start, reloc.end) === '  return a + 1;');
  }
}

/* ── relocateAnchorByContent: refuses ambiguous + missing + weak keys ──────── */
{
  // Two identical lines → ambiguous → must NOT relocate (could pick the wrong one).
  const dup = 'x();\nfoo();\nx();\n';
  check('ambiguous content is refused', relocateAnchorByContent(dup, 'x();').ok === false);
  const dupRes = relocateAnchorByContent(dup, 'x();');
  check('ambiguous reports the reason', !dupRes.ok && dupRes.reason === 'ambiguous');

  // Content that no longer exists → not-found.
  const gone = relocateAnchorByContent(FILE, '  return 999;');
  check('vanished content is not-found', !gone.ok && gone.reason === 'not-found');

  // A blank / whitespace-only line is too weak a key to relocate on safely.
  check('blank line content is rejected', relocateAnchorByContent('a\n\nb\n', '').ok === false);
  check('whitespace-only content is rejected', relocateAnchorByContent('a\n   \nb\n', '   ').ok === false);
  check('undefined snapshot → no-content', relocateAnchorByContent(FILE, undefined).ok === false);

  // CRLF tolerance: the snapshot line (LF) relocates into CRLF content.
  const crlf = FILE.replace(/\n/g, '\r\n');
  const crlfReloc = relocateAnchorByContent(crlf, '  return a + 1;');
  check('relocates across a CRLF file', crlfReloc.ok);
  if (crlfReloc.ok) {
    check('CRLF span excludes the trailing CR', crlf.slice(crlfReloc.start, crlfReloc.end) === '  return a + 1;');
  }
}

/* ── read-tracker line snapshot round-trip ────────────────────────────────── */
{
  clearReadTracker();
  const ABS = '/ws/src/app.ts';
  recordRead(ABS, FILE);
  check('snapshot returns the recorded line', snapshotLineContent(ABS, 3) === '  return a + 1;');
  check('snapshot is 1-based (line 1)', snapshotLineContent(ABS, 1) === 'import { a } from "./a";');
  check('out-of-range line → undefined', snapshotLineContent(ABS, 999) === undefined);
  check('unknown path → undefined', snapshotLineContent('/ws/other.ts', 1) === undefined);

  // A successful write refreshes the snapshot to the new content.
  const edited = FILE.replace('  return a + 1;', '  return a + 42;');
  updateAfterWrite(ABS, edited);
  check('snapshot refreshes after a write', snapshotLineContent(ABS, 3) === '  return a + 42;');

  // The end-to-end zero-retry path: snapshot line + shifted file → relocate.
  clearReadTracker();
  recordRead(ABS, FILE);
  const snap = snapshotLineContent(ABS, 6); // 'function bar() {'
  const shifted = `// header\n// header2\n${FILE}`;
  const reloc = relocateAnchorByContent(shifted, snap);
  check('end-to-end relocate from snapshot succeeds', reloc.ok);
  if (reloc.ok) check('end-to-end lands on the shifted line', reloc.line === 8);

  clearReadTracker();
  check('clear wipes the snapshot', snapshotLineContent(ABS, 1) === undefined);
}

console.log(`\n${passedCount()} checks passed`);
