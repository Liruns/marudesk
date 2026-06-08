import { createHash } from 'node:crypto';

/**
 * Per-line hash anchors for the agent edit engine (v6 §W1 "B" layer). The read
 * view emits a short, stable hash for each line; the model can reference that
 * anchor in an edit instead of copying the line verbatim (token-cheap, no
 * ambiguity), and an anchor that no longer resolves means the file changed since
 * it was read — a stale anchor that the matcher rejects.
 *
 * Both ends live main-side (the read view in text-window.ts, the resolver in
 * patch.ts), so this uses node:crypto and never enters the renderer bundle. The
 * A-layer verbatim `oldString` path (shared/patch.ts) is untouched — anchors are
 * a purely additive, opt-in locator.
 */

/** Hex length of a line anchor — short enough to be cheap, wide enough to avoid intra-file collisions. */
export const ANCHOR_LEN = 7;

/**
 * The stable content anchor for one line: a short SHA-256 over the line text with
 * any trailing CR stripped, so a CRLF/LF difference doesn't change the anchor
 * (matching the A-layer's CR tolerance). Display-only — never written to a file.
 */
export function lineAnchor(line: string): string {
  const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
  return createHash('sha256').update(normalized).digest('hex').slice(0, ANCHOR_LEN);
}

export type AnchorSpan =
  | { ok: true; start: number; end: number }
  | { ok: false; reason: 'not-found' | 'ambiguous' };

/**
 * Resolve `anchor` to the `[start, end)` char span of its line in `content` (the
 * line text, EXCLUDING the trailing newline). The match must be UNIQUE so an
 * anchor can never silently target the wrong line: zero matches ⇒ `not-found`
 * (stale — the line changed or moved), more than one ⇒ `ambiguous` (two identical
 * lines; the caller should fall back to a verbatim/`endAnchor`-bounded edit).
 */
export function locateAnchorLine(content: string, anchor: string): AnchorSpan {
  const lines = content.split('\n');
  let offset = 0;
  let foundStart = -1;
  let start = 0;
  let end = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (lineAnchor(line) === anchor) {
      if (foundStart >= 0) return { ok: false, reason: 'ambiguous' };
      foundStart = i;
      start = offset;
      // Exclude a trailing CR from the span so replacing a CRLF line preserves its
      // \r\n ending (the A-layer fuzzy path does the same) — the \r is still part of
      // the byte stream, just not of the editable line content.
      end = offset + line.length - (line.endsWith('\r') ? 1 : 0);
    }
    offset += line.length + 1; // + 1 for the '\n' that split() removed
  }
  if (foundStart < 0) return { ok: false, reason: 'not-found' };
  return { ok: true, start, end };
}
