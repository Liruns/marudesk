import { lineAnchor, locateAnchorLine, resolveByLineAndHash } from './line-anchor.ts';
import { adjustNewIndent, locatePatch, type PatchOp } from '../../shared/patch.ts';
import { autocorrectNewString } from './edit-normalize.ts';

/**
 * Pure span resolution + sequential composition for the agent edit engine,
 * factored out of patch.ts so it stays dependency-free (no node:fs / Electron /
 * ipc) and can be unit-tested in the plain-node patch-match harness. patch.ts
 * wires these into the disk-backed apply; the renderer never imports this
 * (node:crypto rides in via line-anchor).
 */

export type EditSpan =
  | {
      ok: true;
      start: number;
      end: number;
      /**
       * Whether the A-layer matched FUZZILY (whitespace/CRLF/typography-tolerant)
       * rather than verbatim. Anchored edits report false (they are line-precise).
       * Drives the indentation-delta / newString-autocorrect passes, which only
       * fire on a fuzzy verbatim match where the model's text drifted from disk.
       */
      fuzzy: boolean;
    }
  | { ok: false; reason: string };

/** Whether an op carries a hash anchor (v6 §W1 B-layer), vs a verbatim oldString. */
export function isAnchored(op: PatchOp): boolean {
  return typeof op.anchor === 'string' && op.anchor.length > 0;
}

/**
 * Locate the `[start, end)` char span an edit op replaces. Anchored ops (B-layer)
 * resolve by the line hash — by line-number + hash together when `anchorLine` is
 * supplied (so two identical lines are no longer ambiguous), otherwise by the
 * unique whole-file hash scan — and optionally extend through `endAnchor` for a
 * multi-line span. Everything else uses the A-layer verbatim `oldString` path.
 * Shared by classifyOp (preview) and applyPatch (apply) so the two can't drift.
 * A stale/ambiguous anchor comes back as an error reason.
 */
export function resolveEditSpan(content: string, op: PatchOp): EditSpan {
  if (isAnchored(op)) {
    const anchor = op.anchor as string;
    const startSpan =
      typeof op.anchorLine === 'number'
        ? resolveByLineAndHash(content, op.anchorLine, anchor)
        : locateAnchorLine(content, anchor);
    if (!startSpan.ok) {
      return {
        ok: false,
        reason:
          startSpan.reason === 'ambiguous'
            ? 'anchor matches multiple identical lines; use oldString or an endAnchor'
            : 'anchor not found — the file changed since you read it; re-read it for fresh anchors',
      };
    }
    let end = startSpan.end;
    if (typeof op.endAnchor === 'string' && op.endAnchor.length > 0) {
      const endSpan =
        typeof op.endAnchorLine === 'number'
          ? resolveByLineAndHash(content, op.endAnchorLine, op.endAnchor)
          : locateAnchorLine(content, op.endAnchor);
      if (!endSpan.ok) {
        return {
          ok: false,
          reason:
            endSpan.reason === 'ambiguous'
              ? 'endAnchor matches multiple identical lines; not unique'
              : 'endAnchor not found — re-read the file for fresh anchors',
        };
      }
      if (endSpan.end < startSpan.start) {
        return { ok: false, reason: 'endAnchor precedes anchor' };
      }
      end = endSpan.end;
    }
    return { ok: true, start: startSpan.start, end, fuzzy: false };
  }

  const match = locatePatch(content, op.oldString);
  if (!match.ok) {
    return {
      ok: false,
      reason:
        match.reason === 'ambiguous'
          ? 'oldString matches multiple locations; must be unique'
          : 'oldString not found in file',
    };
  }
  return { ok: true, start: match.start, end: match.end, fuzzy: match.fuzzy };
}

/**
 * The bytes to splice in for an op, given the span it resolved to in `content`.
 * Verbatim (non-anchored) ops normalize the model's `newString` before writing:
 *   1. read-view / diff-marker echo strip + collapsed-multiline / wrapped-line /
 *      indent autocorrect — only on an UNAMBIGUOUS mapping (edit-normalize.ts);
 *   2. when the A-layer matched FUZZILY at a uniformly different indentation than
 *      the model's oldString, shift newString by that same indent delta so the
 *      written result keeps the file's real indentation (shared/patch.ts).
 * Anchored ops keep `newString` verbatim (they target a precise line span and the
 * model controls the replacement line content directly). Pure — same inputs in,
 * same bytes out, so the patch-match harness can assert it.
 */
export function resolveNewString(content: string, op: PatchOp, span: { start: number; end: number; fuzzy: boolean }): string {
  if (isAnchored(op)) return op.newString;
  const actual = content.slice(span.start, span.end);
  // On a fuzzy match, adjustNewIndent owns indentation (a uniform-delta shift), so
  // the autocorrect's paired indent-restore pass is skipped to avoid double-indent.
  const corrected = autocorrectNewString(actual, op.newString, { restoreIndent: !span.fuzzy });
  return span.fuzzy ? adjustNewIndent(op.oldString, actual, corrected) : corrected;
}

export type SequentialEditResult =
  | { ok: true; next: string }
  | { ok: false; reason: string; opIndex: number };

/**
 * Apply a sequence of ops to ONE file's content, in order, re-resolving each op's
 * span against the RUNNING content (not the original). This is how multiple edits
 * to the same file compose: a later op sees the earlier op's result, so two edits
 * to different regions both land, and an op targeting text an earlier op removed
 * fails cleanly (`opIndex`) instead of silently overwriting it. Pure — patch.ts
 * feeds it the disk content and writes the single resulting `next` once, so the
 * file is renamed only once (no last-write-wins race across same-file ops).
 */
export function resolveSequentialEdits(content: string, ops: PatchOp[]): SequentialEditResult {
  let cur = content;
  for (let i = 0; i < ops.length; i++) {
    const span = resolveEditSpan(cur, ops[i]);
    if (!span.ok) return { ok: false, reason: span.reason, opIndex: i };
    const newString = resolveNewString(cur, ops[i], span);
    cur = cur.slice(0, span.start) + newString + cur.slice(span.end);
  }
  return { ok: true, next: cur };
}

/* ── batch anchor validation + self-healing remap (EDIT-1 follow-up §4-5) ─── */

/** One op that failed to resolve against the current file, with its path + why. */
export type AnchorFailure = {
  /** Index into the validated batch (so the caller can correlate). */
  opIndex: number;
  path: string;
  reason: string;
};

/**
 * Raised by {@link batchValidateAnchors} when one or more ops no longer resolve
 * against the current file content (stale/ambiguous anchor, vanished oldString).
 * It carries the WHOLE batch of failures — so the model can re-anchor every
 * failing edit in one retry instead of one-at-a-time — plus `remaps`: each stale
 * anchor string mapped to the FRESH anchor of the line the model meant. A remap
 * is derivable only when the op carried `anchorLine` (the read-view line number),
 * so the current content at that 1-based line yields a fresh {@link lineAnchor}.
 */
export class AnchorMismatchError extends Error {
  readonly failures: readonly AnchorFailure[];
  readonly remaps: ReadonlyMap<string, string>;

  constructor(failures: readonly AnchorFailure[], remaps: ReadonlyMap<string, string>) {
    super(`${failures.length} edit op(s) no longer resolve against the current file`);
    this.name = 'AnchorMismatchError';
    this.failures = failures;
    this.remaps = remaps;
  }
}

/** One op paired with the CURRENT content of the file it targets (disk read by the caller). */
export type ValidatedOp = { op: PatchOp; current: string };

/**
 * Validate a batch of edit ops against each target file's current content and,
 * if ANY fail, throw a single {@link AnchorMismatchError} listing every failing
 * op (path + reason) and a best-effort `remaps` table for re-anchoring. Pure (no
 * fs/Electron): the caller supplies each op's already-read `current` content, so
 * this stays harness-testable. Creates (empty oldString, no anchor) are skipped —
 * they have nothing to clobber. Returns normally when every op resolves.
 */
export function batchValidateAnchors(entries: readonly ValidatedOp[]): void {
  const failures: AnchorFailure[] = [];
  const remaps = new Map<string, string>();
  for (let i = 0; i < entries.length; i++) {
    const { op, current } = entries[i];
    // Creates have nothing to resolve against — skip (applyPatch handles them).
    if (op.oldString.length === 0 && !isAnchored(op)) continue;
    const span = resolveEditSpan(current, op);
    if (span.ok) continue;
    failures.push({ opIndex: i, path: op.path, reason: span.reason });
    // Derive a fresh anchor for the line the model meant: only possible when the
    // op named the read-view line number, so we can re-hash the current line text.
    if (isAnchored(op) && typeof op.anchorLine === 'number') {
      const fresh = freshAnchorAt(current, op.anchorLine);
      const stale = op.anchor as string;
      if (fresh !== null && fresh !== stale) remaps.set(stale, fresh);
    }
    if (typeof op.endAnchor === 'string' && op.endAnchor.length > 0 && typeof op.endAnchorLine === 'number') {
      const fresh = freshAnchorAt(current, op.endAnchorLine);
      if (fresh !== null && fresh !== op.endAnchor) remaps.set(op.endAnchor, fresh);
    }
  }
  if (failures.length > 0) throw new AnchorMismatchError(failures, remaps);
}

/** Fresh {@link lineAnchor} of the 1-based line `lineNo` in `content`, or null if out of range. */
function freshAnchorAt(content: string, lineNo: number): string | null {
  const lines = content.split('\n');
  if (!Number.isInteger(lineNo) || lineNo < 1 || lineNo > lines.length) return null;
  return lineAnchor(lines[lineNo - 1]);
}

/* ── zero-retry stale-anchor relocate (SECOND-PASS item 5) ─────────────────── */

/** A successful content-relocate: the fresh anchor + 1-based line of the re-found line. */
export type RelocateResult =
  | { ok: true; anchor: string; line: number; start: number; end: number }
  | { ok: false; reason: 'not-found' | 'ambiguous' | 'no-content' };

/**
 * Re-locate a stale anchor by the exact LINE CONTENT the model originally saw
 * (SECOND-PASS item 5 / gajae hashline/recovery.ts). When an anchored edit goes
 * stale because the file shifted, the per-read line snapshot (read-tracker.ts)
 * still holds the exact text of the line the model anchored to; this finds that
 * SAME text in the CURRENT content and returns a fresh anchor for it — so the edit
 * can re-resolve WITHOUT a model round-trip.
 *
 * Deliberately conservative — it never guesses:
 *  - the match must be the WHOLE line (CR-tolerant), not a substring;
 *  - it must be UNIQUE (zero matches → not-found, more than one → ambiguous);
 *  - empty/whitespace-only snapshot content is rejected (`no-content`) because a
 *    blank or trivial line is never a safe unique key.
 * On anything less than an exact, unique match it fails and the caller falls back
 * to the normal "re-read the file" self-heal. This CANNOT relocate to the wrong
 * line, so edit safety is preserved.
 */
export function relocateAnchorByContent(content: string, snapshotLine: string | undefined): RelocateResult {
  if (snapshotLine === undefined) return { ok: false, reason: 'no-content' };
  const target = snapshotLine.endsWith('\r') ? snapshotLine.slice(0, -1) : snapshotLine;
  // A blank/whitespace-only line is too weak a key to ever relocate on safely.
  if (target.trim().length === 0) return { ok: false, reason: 'no-content' };
  const lines = content.split('\n');
  let offset = 0;
  let foundLine = -1;
  let start = 0;
  let end = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const bare = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (bare === target) {
      if (foundLine >= 0) return { ok: false, reason: 'ambiguous' };
      foundLine = i;
      start = offset;
      end = offset + line.length - (line.endsWith('\r') ? 1 : 0);
    }
    offset += line.length + 1; // + 1 for the '\n' split() removed
  }
  if (foundLine < 0) return { ok: false, reason: 'not-found' };
  return { ok: true, anchor: lineAnchor(target), line: foundLine + 1, start, end };
}
