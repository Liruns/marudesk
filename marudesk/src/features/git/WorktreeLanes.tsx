import { useCallback, useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  GitBranch,
  GitMerge,
  GitPullRequest,
  Loader2,
  Play,
  Square,
  Trash2,
} from 'lucide-react';
import { useI18n } from '../../i18n/useI18n';
import { cn } from '../../lib/cn';
import { toast } from '../../lib/toast';
import type { LaneDevState } from '../../../shared/lanes';
import { isAgentWorktreeBranch, type WorktreeLane } from '../../../shared/worktree';

/**
 * Worktree lanes board (docs/runtime-agent-absorption-2026-06.md §3.8 Mission
 * Control) — lists every git worktree of the active repo with its pending-change
 * count, shown beside the single-worktree isolation bar. Each lane can:
 *   - run/stop its dev server (`settings.lanes.devCommand` in the lane's dir) and
 *     open the detected localhost URL in a browser tab, and
 *   - (agent lanes only) merge back into the base branch or be discarded.
 * Per-lane PR/CI orchestration remains the larger follow-on.
 */
function laneLabel(lane: WorktreeLane): string {
  if (lane.branch) return lane.branch;
  const parts = lane.path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || lane.path;
}

export function WorktreeLanes() {
  const { t } = useI18n();
  const [lanes, setLanes] = useState<WorktreeLane[] | null>(null);
  const [dev, setDev] = useState<Record<string, LaneDevState>>({});
  const [open, setOpen] = useState(false);

  // Live per-lane dev-server state, keyed by worktree path.
  useEffect(() => {
    const apply = (states: LaneDevState[]) =>
      setDev(Object.fromEntries(states.map((s) => [s.path, s])));
    void window.marudesk.invoke('lanes-dev:list').then(apply).catch(() => {});
    return window.marudesk.on('lanes:dev-state', apply);
  }, []);

  const startDev = async (lane: WorktreeLane) => {
    const res = await window.marudesk.invoke('lanes-dev:start', { path: lane.path });
    if (!res.ok) {
      toast({
        title:
          res.reason === 'no-command'
            ? t('git.worktrees.devNoCommand')
            : t('git.worktrees.devFailed'),
        variant: 'error',
      });
    }
  };
  const stopDev = (lane: WorktreeLane) => void window.marudesk.invoke('lanes-dev:stop', { path: lane.path });
  const openDev = (lane: WorktreeLane) => void window.marudesk.invoke('lanes-dev:open', { path: lane.path });

  const openPr = async (lane: WorktreeLane) => {
    const res = await window.marudesk.invoke('git:worktree-open-pr', { path: lane.path });
    if (res.ok) {
      if (!res.pushed) toast({ title: t('git.worktrees.prNotPushed'), variant: 'error' });
    } else {
      toast({
        title: res.reason === 'no-remote' || res.reason === 'not-github'
          ? t('git.worktrees.prNoRemote')
          : t('git.worktrees.prFailed'),
        variant: 'error',
      });
    }
  };

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
              {(() => {
                const d = dev[lane.path];
                const running = d && (d.status === 'running' || d.status === 'starting');
                return (
                  <>
                    {running && d.url ? (
                      <button
                        type="button"
                        onClick={() => openDev(lane)}
                        title={t('git.worktrees.devOpen')}
                        className="shrink-0 rounded p-0.5 text-accent hover:bg-accent-subtle"
                      >
                        <ExternalLink size={12} />
                      </button>
                    ) : null}
                    {running ? (
                      <button
                        type="button"
                        onClick={() => stopDev(lane)}
                        title={t('git.worktrees.devStop')}
                        className={cn(
                          'shrink-0 rounded p-0.5',
                          d.status === 'starting' ? 'text-fg-tertiary' : 'text-success hover:bg-error-subtle hover:text-error',
                        )}
                      >
                        {d.status === 'starting' ? <Loader2 size={12} className="animate-spin" /> : <Square size={12} />}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void startDev(lane)}
                        title={t('git.worktrees.devStart')}
                        className="shrink-0 rounded p-0.5 text-fg-tertiary opacity-0 transition-opacity duration-fast hover:bg-accent-subtle hover:text-accent group-hover:opacity-100 focus-visible:opacity-100"
                      >
                        <Play size={12} />
                      </button>
                    )}
                  </>
                );
              })()}
              {!lane.isMain && lane.branch && isAgentWorktreeBranch(lane.branch) ? (
                <>
                  <button
                    type="button"
                    onClick={() => void openPr(lane)}
                    title={t('git.worktrees.openPr')}
                    className="shrink-0 rounded p-0.5 text-fg-tertiary opacity-0 transition-opacity duration-fast hover:bg-accent-subtle hover:text-accent group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    <GitPullRequest size={12} />
                  </button>
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
