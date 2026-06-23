import { useEffect, useState } from 'react';
import { Boxes, GitMerge, Loader2, Play, Trash2 } from 'lucide-react';
import { useI18n } from '../../i18n/useI18n';
import { useGitStore } from './store';
import { humanizeError } from '../../lib/humanizeError';
import type { WorktreeIsolationStatus } from '../../../shared/worktree';

/**
 * Worktree isolation control (Stage 12-B) in the Source Control panel. When the
 * open workspace is a local git repo it offers "Run isolated" — the agent then
 * works in a dedicated git worktree on its own branch; this bar shows the branch
 * + pending-change count with Merge-back / Discard actions. Renders nothing for
 * a non-git (or SSH) workspace. Re-checks whenever the git status changes.
 */
export function WorktreeIsolationBar() {
  const { t } = useI18n();
  const gitStatus = useGitStore((s) => s.status);
  const refreshGit = useGitStore((s) => s.refresh);
  const [iso, setIso] = useState<WorktreeIsolationStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void window.marudesk
      .invoke('git:worktree-status')
      .then((s) => {
        if (alive) setIso(s);
      })
      .catch(() => {
        if (alive) setIso(null);
      });
    return () => {
      alive = false;
    };
    // Re-check when the git state changes (panel open, after a commit/merge, etc.).
  }, [gitStatus]);

  // Hidden until we know the repo is at least eligible (local git).
  if (!iso || (!iso.active && !iso.eligible)) return null;

  const reload = async (): Promise<void> => {
    try {
      setIso(await window.marudesk.invoke('git:worktree-status'));
    } catch {
      setIso(null);
    }
  };

  const enter = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setIso(await window.marudesk.invoke('git:worktree-enter'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const merge = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await window.marudesk.invoke('git:worktree-merge');
      if (!res.ok) {
        setError(res.reason === 'conflict' ? t('git.worktree.conflict') : `${t('git.worktree.mergeFailed')}: ${res.message}`);
      }
      await reload();
      await refreshGit();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const discard = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await window.marudesk.invoke('git:worktree-discard');
      await reload();
      await refreshGit();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="shrink-0 flex flex-col gap-1 px-3 py-1.5 border-b border-subtle">
      <div className="flex items-center gap-1.5 min-w-0">
        <Boxes size={12} className="shrink-0 text-fg-tertiary" />
        {iso.active ? (
          <>
            <span className="text-caption font-medium text-accent shrink-0">{t('git.worktree.active')}</span>
            <span className="text-caption font-mono text-fg-tertiary truncate" title={iso.branch}>
              {iso.branch.replace(/^marudesk\/agent\//, '')}
            </span>
            <span className="text-caption text-fg-tertiary shrink-0 ml-auto tabular-nums">
              {iso.changes.count > 0 ? iso.changes.count : t('git.worktree.noChanges')}
            </span>
            <button
              type="button"
              onClick={() => void merge()}
              disabled={busy}
              title={t('git.worktree.merge')}
              aria-label={t('git.worktree.merge')}
              className="shrink-0 text-fg-tertiary hover:text-accent disabled:opacity-50"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <GitMerge size={12} />}
            </button>
            <button
              type="button"
              onClick={() => void discard()}
              disabled={busy}
              title={t('git.worktree.discard')}
              aria-label={t('git.worktree.discard')}
              className="shrink-0 text-fg-tertiary hover:text-error disabled:opacity-50"
            >
              <Trash2 size={12} />
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => void enter()}
            disabled={busy}
            title={t('git.worktree.runIsolatedHint')}
            className="flex items-center gap-1 text-caption text-fg-secondary hover:text-accent disabled:opacity-50"
          >
            {busy ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
            {t('git.worktree.runIsolated')}
          </button>
        )}
      </div>
      {error ? <span className="text-caption text-error break-words">{humanizeError(error)}</span> : null}
    </div>
  );
}
