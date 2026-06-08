import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, GitBranch } from 'lucide-react';
import { useI18n } from '../../i18n/useI18n';
import type { WorktreeLane } from '../../../shared/worktree';

/**
 * Worktree lanes board (docs/runtime-agent-absorption-2026-06.md §3.8) — a
 * read-only list of every git worktree of the active repo with its pending-change
 * count, shown in the Source Control panel beside the single-worktree isolation
 * bar. Reuses the existing worktree backend (git:worktree-list). Per-lane dev
 * server / browser / PR / CI are the later, larger surface.
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

  useEffect(() => {
    let alive = true;
    void window.marudesk
      .invoke('git:worktree-list')
      .then((res) => {
        if (alive) setLanes(res);
      })
      .catch(() => {
        if (alive) setLanes([]);
      });
    return () => {
      alive = false;
    };
  }, []);

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
              className="flex items-center gap-2 px-3 py-1 text-caption"
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
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
