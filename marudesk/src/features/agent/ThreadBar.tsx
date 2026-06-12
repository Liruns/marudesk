import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import type { AgentWorkspaceThreadsEvent, ThreadSummary } from '../../../shared/agent';
import { useAgentPanelKey, useAgentStore, useAgentWorkspaceId } from './store';
import { useI18n } from '../../i18n/useI18n';

/**
 * Thread switcher (Stage 12-B-2). Tabs for the open conversation threads — click
 * to switch, ✕ to close, + to start a new one. Main owns the registry; this is a
 * projection fed by the scoped thread event stream (pushed on every emit + on
 * structure changes). Hidden until there's more than one thread.
 *
 * In a panel-scoped surface (an AI Chat tab bound to its own thread), switching
 * REBINDS this panel to the picked thread — the panel's binding is its own, so
 * the workspace-active marker streaming from main must never overwrite it
 * (that's how two panels used to end up mirroring one conversation).
 */
export function ThreadBar() {
  const { t } = useI18n();
  const workspaceId = useAgentWorkspaceId();
  const panelKey = useAgentPanelKey();
  const setActiveThreadId = useAgentStore((s) => s.setActiveThreadId);
  const activeThreadId = useAgentStore((s) => s.activeThreadId);
  const [threads, setThreadsState] = useState<ThreadSummary[]>([]);
  const [busy, setBusy] = useState(false);

  const setThreads = useCallback(
    (next: ThreadSummary[]): void => {
      setThreadsState(next);
      // Only an active-follower surface tracks the workspace-active thread; a
      // panel keeps its own binding.
      if (!panelKey) setActiveThreadId(next.find((thread) => thread.active)?.id ?? null);
    },
    [setActiveThreadId, panelKey],
  );

  useEffect(() => {
    void window.marudesk
      .invoke('agent:list-threads', { workspaceId })
      .then(setThreads)
      .catch(() => {});
    const off = workspaceId
      ? window.marudesk.on('agent:workspace-threads', (event: AgentWorkspaceThreadsEvent) => {
          if (event.workspaceId === workspaceId) setThreads(event.threads);
        })
      : window.marudesk.on('agent:threads', (list: ThreadSummary[]) => setThreads(list));
    return off;
  }, [setThreads, workspaceId]);

  const run = async (op: () => Promise<ThreadSummary[]>): Promise<void> => {
    setBusy(true);
    try {
      setThreads(await op());
    } catch {
      // leave the list as-is on a transient failure
    } finally {
      setBusy(false);
    }
  };

  const newThread = () =>
    run(async () => {
      const next = await window.marudesk.invoke('agent:new-thread', { workspaceId });
      if (panelKey) setActiveThreadId(next.find((thread) => thread.active)?.id ?? null);
      return next;
    });
  const switchTo = (id: string) => {
    // Rebind the panel BEFORE the invoke so the switched thread's state push
    // passes the panel's threadId filter.
    if (panelKey) setActiveThreadId(id);
    return run(() => window.marudesk.invoke('agent:switch-thread', { id, workspaceId }));
  };
  const close = (id: string) =>
    run(async () => {
      const next = await window.marudesk.invoke('agent:close-thread', { id, workspaceId });
      // Closing the panel's own thread: rebind to whatever main made active.
      if (panelKey && id === activeThreadId) {
        setActiveThreadId(next.find((thread) => thread.active)?.id ?? null);
      }
      return next;
    });

  // Single-thread case: just the "+" affordance, kept unobtrusive.
  const multi = threads.length > 1;
  const isActive = (thread: ThreadSummary): boolean =>
    panelKey ? thread.id === activeThreadId : thread.active;

  return (
    <div className="flex items-center gap-0.5 px-2 py-1.5 border-b border-subtle/70 overflow-x-auto scrollbar-none">
      {multi &&
        threads.map((t) => (
          <div
            key={t.id}
            className={cn(
              'group flex items-center gap-1.5 rounded-md px-2 py-1 text-caption max-w-44 shrink-0 cursor-pointer transition-colors duration-fast',
              isActive(t)
                ? 'bg-surface-2 text-fg-primary shadow-highlight'
                : 'text-fg-tertiary hover:bg-surface-1/80 hover:text-fg-secondary',
            )}
            onClick={() => !isActive(t) && void switchTo(t.id)}
            title={t.title}
          >
            {t.busy ? (
              <Loader2 size={10} className="shrink-0 animate-spin text-accent" />
            ) : (
              <span className={cn('shrink-0 size-1.5 rounded-full', isActive(t) ? 'bg-accent' : 'bg-fg-tertiary/30')} />
            )}
            <span className="truncate">{t.title}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void close(t.id);
              }}
              disabled={busy || threads.length <= 1}
              aria-label={`Close ${t.title}`}
              className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-fast text-fg-tertiary hover:text-error disabled:opacity-0"
            >
              <X size={10} />
            </button>
          </div>
        ))}
      <button
        type="button"
        onClick={() => void newThread()}
        disabled={busy}
        aria-label={t('agent.thread.new')}
        title={t('agent.thread.new')}
        className="shrink-0 flex items-center gap-1 rounded-md px-1.5 py-1 text-caption text-fg-tertiary hover:bg-surface-1/80 hover:text-fg-secondary transition-colors duration-fast disabled:opacity-50"
      >
        <Plus size={12} />
        {!multi && <span>{t('agent.thread.new')}</span>}
      </button>
    </div>
  );
}
