/**
 * Pure helpers for git conflict markers in a text buffer — no Monaco, no IPC —
 * so the editor's conflict aid (conflict-decorations.ts) stays unit-testable.
 *
 * A conflict block is the classic marker sandwich:
 *
 *   <<<<<<< HEAD            ← start
 *   current (ours) lines
 *   |||||||  base           ← optional diff3 section (treated as neither side)
 *   =======                 ← separator
 *   incoming (theirs) lines
 *   >>>>>>> branch          ← end
 *
 * All line numbers are 1-based, matching Monaco. Lines are matched with any
 * trailing `\r` ignored so CRLF buffers parse identically; reconstruction keeps
 * the original lines verbatim, so line endings survive a round trip.
 */

export type ConflictBlock = {
  /** Line of the `<<<<<<<` marker. */
  start: number;
  /** Line of the `|||||||` diff3 base marker, or null without one. */
  base: number | null;
  /** Line of the `=======` separator. */
  sep: number;
  /** Line of the `>>>>>>>` marker. */
  end: number;
  /** Label after `<<<<<<<` (e.g. "HEAD"), or empty. */
  currentLabel: string;
  /** Label after `>>>>>>>` (e.g. a branch name), or empty. */
  incomingLabel: string;
};

export type ConflictChoice = 'current' | 'incoming' | 'both';

const START_RE = /^<{7}(?:\s+(.*))?$/;
const BASE_RE = /^\|{7}(?:\s.*)?$/;
const SEP_RE = /^={7}$/;
const END_RE = /^>{7}(?:\s+(.*))?$/;

/** Strip one trailing CR so CRLF lines match the marker regexes. */
function bare(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/**
 * Find every well-formed conflict block in `text`. A start marker without a
 * matching separator + end marker (in order) is skipped — better to decorate
 * nothing than to mangle text on a malformed block.
 */
export function findConflictBlocks(text: string): ConflictBlock[] {
  const lines = text.split('\n');
  const blocks: ConflictBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const startMatch = START_RE.exec(bare(lines[i]));
    if (!startMatch) continue;
    let base: number | null = null;
    let sep = -1;
    let end = -1;
    let incomingLabel = '';
    for (let j = i + 1; j < lines.length; j++) {
      const line = bare(lines[j]);
      if (sep < 0 && base === null && BASE_RE.test(line)) {
        base = j + 1;
        continue;
      }
      if (sep < 0 && SEP_RE.test(line)) {
        sep = j + 1;
        continue;
      }
      // A new start before this block closed: the current block is malformed.
      if (START_RE.test(line)) break;
      const endMatch = END_RE.exec(line);
      if (endMatch && sep > 0) {
        end = j + 1;
        incomingLabel = (endMatch[1] ?? '').trim();
        break;
      }
    }
    if (sep < 0 || end < 0) continue;
    blocks.push({
      start: i + 1,
      base,
      sep,
      end,
      currentLabel: (startMatch[1] ?? '').trim(),
      incomingLabel,
    });
    i = end - 1; // resume scanning after this block
  }
  return blocks;
}

/**
 * The replacement lines for a block under a choice: the current section, the
 * incoming section, or both (current first). The marker lines and any diff3
 * base section are always dropped. Lines are returned verbatim (CR kept), so
 * callers can splice them straight back into the original line array.
 */
export function conflictChoiceLines(
  lines: readonly string[],
  block: ConflictBlock,
  choice: ConflictChoice,
): string[] {
  // Current section: between <<<<<<< and (||||||| or =======), exclusive.
  const currentEnd = (block.base ?? block.sep) - 1;
  const current = lines.slice(block.start, currentEnd);
  // Incoming section: between ======= and >>>>>>>, exclusive.
  const incoming = lines.slice(block.sep, block.end - 1);
  if (choice === 'current') return current;
  if (choice === 'incoming') return incoming;
  return [...current, ...incoming];
}

/**
 * Apply a choice to one block of `text`, returning the new full text. The
 * block must come from {@link findConflictBlocks} on this exact text; a stale
 * block (markers no longer where it says) is a no-op rather than a mangle.
 */
export function applyConflictChoice(
  text: string,
  block: ConflictBlock,
  choice: ConflictChoice,
): string {
  const lines = text.split('\n');
  const startLine = lines[block.start - 1];
  const endLine = lines[block.end - 1];
  if (
    startLine === undefined ||
    endLine === undefined ||
    !START_RE.test(bare(startLine)) ||
    !END_RE.test(bare(endLine))
  ) {
    return text;
  }
  const replacement = conflictChoiceLines(lines, block, choice);
  lines.splice(block.start - 1, block.end - block.start + 1, ...replacement);
  return lines.join('\n');
}
