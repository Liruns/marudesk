import type { GitChange, GitFileStatus } from '../../../shared/git';

/**
 * Map a porcelain status code to a single-letter badge + a Tailwind color
 * token, VSCode-style (M=modified amber, A=added green, D=deleted red, …).
 * The badge shows the most meaningful half of the XY pair for the bucket the
 * row lives in.
 */

const META: Record<string, { letter: string; className: string; title: string }> = {
  M: { letter: 'M', className: 'text-warning', title: 'Modified' },
  A: { letter: 'A', className: 'text-success', title: 'Added' },
  D: { letter: 'D', className: 'text-error', title: 'Deleted' },
  R: { letter: 'R', className: 'text-accent', title: 'Renamed' },
  C: { letter: 'C', className: 'text-accent', title: 'Copied' },
  T: { letter: 'T', className: 'text-warning', title: 'Type changed' },
  U: { letter: 'U', className: 'text-error', title: 'Conflict' },
  '?': { letter: 'U', className: 'text-success', title: 'Untracked' },
};

/** Pick the code to badge: index half for a staged row, worktree half else. */
export function statusBadge(
  change: GitChange,
  staged: boolean,
): { letter: string; className: string; title: string } {
  if (change.conflicted) return META.U;
  if (change.untracked) return META['?'];
  const code: GitFileStatus = staged
    ? change.indexStatus
    : change.worktreeStatus;
  return META[code] ?? { letter: code.trim() || '•', className: 'text-fg-tertiary', title: 'Changed' };
}

/** The base name of a workspace-relative path, for the bold row label. */
export function baseName(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i >= 0 ? rel.slice(i + 1) : rel;
}

/** The directory portion (without trailing slash), for the dimmed row suffix. */
export function dirName(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i >= 0 ? rel.slice(0, i) : '';
}
