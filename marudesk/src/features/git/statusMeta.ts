import type { GitChange, GitFileStatus } from '../../../shared/git';
import type { TranslationKey } from '../../i18n/messages';

/**
 * Map a porcelain status code to a single-letter badge + a Tailwind color
 * token, VSCode-style (M=modified amber, A=added green, D=deleted red, …).
 * The badge shows the most meaningful half of the XY pair for the bucket the
 * row lives in.
 */

const META: Record<string, { letter: string; className: string; titleKey: TranslationKey }> = {
  M: { letter: 'M', className: 'text-warning', titleKey: 'git.status.modified' },
  A: { letter: 'A', className: 'text-success', titleKey: 'git.status.added' },
  D: { letter: 'D', className: 'text-error', titleKey: 'git.status.deleted' },
  R: { letter: 'R', className: 'text-accent', titleKey: 'git.status.renamed' },
  C: { letter: 'C', className: 'text-accent', titleKey: 'git.status.copied' },
  T: { letter: 'T', className: 'text-warning', titleKey: 'git.status.typeChanged' },
  U: { letter: 'U', className: 'text-error', titleKey: 'git.status.conflict' },
  '?': { letter: 'U', className: 'text-success', titleKey: 'git.status.untracked' },
};

/** Pick the code to badge: index half for a staged row, worktree half else. */
export function statusBadge(
  change: GitChange,
  staged: boolean,
): { letter: string; className: string; titleKey: TranslationKey } {
  if (change.conflicted) return META.U;
  if (change.untracked) return META['?'];
  const code: GitFileStatus = staged
    ? change.indexStatus
    : change.worktreeStatus;
  return META[code] ?? {
    letter: code.trim() || '•',
    className: 'text-fg-tertiary',
    titleKey: 'git.status.changed',
  };
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
