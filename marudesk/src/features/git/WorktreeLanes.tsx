import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, GitBranch, GitMerge, Trash2 } from 'lucide-react';
import { useI18n } from '../../i18n/useI18n';
import { toast } from '../../lib/toast';
import { isAgentWorktreeBranch, type WorktreeLane } from '../../../shared/worktree';

/**
 * Worktree lanes board (docs/runtime-agent-absorption-2026-06.md §3.8) — lists
 * every git worktree of the active repo with its pending-change count, shown in
 * the Source Control panel beside the single-worktree isolation bar. Stale agent
 * lanes (marudesk/agent/*) can be discarded inline; the main tree and any
 * non-agent worktree are never removable here (the backend refuses them too).
 * Per-lane dev server / browser / PR / CI remain the larger follow-on.
 */
function laneLabel(lane: WorktreeLane): string {
  if (lane.branch) return lane.branch;
  const parts = lane.path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || lane.path;
}

export function WorktreeLanes() {
  const { t } = useI18n();
  const [lanes, setLanes] = useState<WorktreeLane[] | null>(null);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(() => {
    void window.marudesk
      .invoke('git:worktree-list')
      .then(setLanes)
      .catch(() => setLanes([]));
  }, []);
  useEffect(() => refresh(), [refresh]);

  const discard = async (lane: WorktreeLane) => {
    if (!window.confirm(`${t('git.worktrees.discardConfirm')}\n\n${lane.branch ?? lane.path}`)) return;
    const res = await window.marudesk.invoke('git:worktree-remove', { path: lane.path });
    if (res.ok) refresh();
    else toast({ title: t('git.worktrees.discardFailed'), variant: 'error' });
  };

  const merge = async (lane: WorktreeLane) => {
    if (!window.confirm(`${t('git.worktrees.mergeConfirm')}\n\n${lane.branch ?? lane.path}`)) return;
    const res = await window.marudesk.invoke('git:worktree-merge-lane', { path: lane.path });
    if (res.ok) {
      refresh();
      toast({ title: t('git.worktrees.mergeOk'), description: lane.branch ?? undefined, variant: 'success' });
    } else {
      toast({
        title: res.reason === 'conflict' ? t('git.worktrees.mergeConflict') : t('git.worktrees.mergeFailed'),
        description: res.message,
        variant: 'error',
      });
    }
  };

  // A single (main) worktree is the common case and not worth a board.
  if (!lanes || lanes.length < 2) return null;

  return (
    <div className="shrink-0 border-b border-subtle">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 h-7 text-caption uppercase tracking-wide text-fg-tertiary hover:text-fg-secondary"
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <GitBranch size={12} />
        <span>{t('git.worktrees.title')}</span>
        <span className="tabular-nums">{lanes.length}</span>
      </button>
      {open ? (
        <ul className="pb-1">
          {lanes.map((lane) => (
            <li
              key={lane.path}
              title={lane.path}
              className="group flex items-center gap-2 px-3 py-1 text-caption"
            >
              <span className="flex-1 truncate text-fg-secondary">{laneLabel(lane)}</span>
              {lane.isMain ? (
                <span className="shrink-0 rounded-pill bg-surface-2 px-1.5 text-fg-tertiary">
                  {t('git.worktrees.main')}
                </span>
              ) : null}
              {lane.changes > 0 ? (
                <span
                  className="shrink-0 tabular-nums text-warning"
                  title={t('git.worktrees.changes')}
                >
                  {lane.changes}
                </span>
              ) : null}
              {!lane.isMain && lane.branch && isAgentWorktreeBranch(lane.branch) ? (
                <>
                  <button
                    type="button"
                    onClick={() => void merge(lane)}
                    title={t('git.worktrees.merge')}
                    className="shrink-0 rounded p-0.5 text-fg-tertiary opacity-0 transition-opacity duration-fast hover:bg-accent-subtle hover:text-accent group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    <GitMerge size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => void discard(lane)}
                    title={t('git.worktrees.discard')}
                    className="shrink-0 rounded p-0.5 text-fg-tertiary opacity-0 transition-opacity duration-fast hover:bg-error-subtle hover:text-error group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    <Trash2 size={12} />
                  </button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
