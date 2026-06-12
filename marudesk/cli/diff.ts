/**
 * Minimal line-diff for the TUI's approval panel (cli/ — chat CLI v2). Pure and
 * dependency-free like the rest of cli/, so the harness can exercise it
 * headlessly. Not a general diff: it trims the common prefix/suffix line runs
 * and reports the differing middle, which is exactly the shape of the
 * single-hunk edits the approval flow previews.
 */

export type DiffHunk = {
  removed: string[];
  added: string[];
  /** Lines cut from each side to honor `cap` (0 when everything fit). */
  removedOmitted: number;
  addedOmitted: number;
};

const toLines = (text: string): string[] => (text.length === 0 ? [] : text.split('\n'));

/**
 * The differing middle of `before` → `after` as removed/added line runs, each
 * capped at `cap` lines (the omitted counts let the caller render "… n more").
 */
export function diffHunk(before: string, after: string, cap = 4): DiffHunk {
  const a = toLines(before);
  const b = toLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const removed = a.slice(start, endA);
  const added = b.slice(start, endB);
  return {
    removed: removed.slice(0, cap),
    added: added.slice(0, cap),
    removedOmitted: Math.max(0, removed.length - cap),
    addedOmitted: Math.max(0, added.length - cap),
  };
}
