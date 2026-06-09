import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { useI18n } from '../../i18n/useI18n';
import { cn } from '../../lib/cn';
import type { AgentWorkspaceThreadsEvent, ThreadSummary } from '../../../shared/agent';
import { useAgentStore, useAgentWorkspaceId } from '../agent/store';
import { ApprovalCard } from '../agent/chat/Cards';
import { buildAgentRows } from '../devtools/panels/evidence-rows';

/**
 * Supervisor rail (§3.5): a single-glance overview across all agent threads —
 * each thread's status/busy, a persistent pending-approval card (reused from the
 * chat), and the recent page-action log. Reuses the scoped thread subscription
 * (like ThreadBar) and the active thread's agent snapshot,
 * so it adds a vantage point, not new plumbing.
 */
const RECENT_LIMIT = 12;

export function SupervisorRail() {
  const { t } = useI18n();
  const workspaceId = useAgentWorkspaceId();
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const pendingApproval = useAgentStore((s) => s.chat.pendingApproval);
  const messages = useAgentStore((s) => s.chat.messages);

  useEffect(() => {
    void window.marudesk.invoke('agent:list-threads', { workspaceId }).then(setThreads).catch(() => {});
    const off = workspaceId
      ? window.marudesk.on('agent:workspace-threads', (event: AgentWorkspaceThreadsEvent) => {
          if (event.workspaceId === workspaceId) setThreads(event.threads);
        })
      : window.marudesk.on('agent:threads', (list: ThreadSummary[]) => setThreads(list));
    return off;
  }, [workspaceId]);

  const switchTo = (id: string) =>
    void window.marudesk.invoke('agent:switch-thread', { id, workspaceId }).then(setThreads).catch(() => {});

  const recent = useMemo(() => buildAgentRows(messages).sort((a, b) => b.t - a.t).slice(0, RECENT_LIMIT), [messages]);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-4">
      {/* Pending approval, surfaced wherever the user is looking. */}
      {pendingApproval ? <ApprovalCard approval={pendingApproval} /> : null}

      {/* Threads overview. */}
      <section className="flex flex-col gap-1.5">
        <h3 className="text-caption uppercase tracking-wide text-fg-tertiary">
          {t('supervisor.threads')} <span className="tabular-nums">{threads.length}</span>
        </h3>
        {threads.length === 0 ? (
          <p className="text-body-sm text-fg-tertiary">{t('supervisor.noThreads')}</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {threads.map((th) => (
              <li key={th.id}>
                <button
                  type="button"
                  onClick={() => !th.active && switchTo(th.id)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-body-sm transition-colors duration-fast',
                    th.active ? 'bg-surface-2 text-fg-primary' : 'text-fg-secondary hover:bg-surface-1',
                  )}
                  title={th.title}
                >
                  {th.busy ? (
                    <Loader2 size={12} className="shrink-0 animate-spin text-accent" />
                  ) : (
                    <span
                      className={cn('shrink-0 size-1.5 rounded-full', th.active ? 'bg-accent' : 'bg-fg-tertiary/40')}
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate">{th.title}</span>
                  <span className="shrink-0 text-caption text-fg-tertiary">{th.status}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Recent page actions (the live page-action log). */}
      <section className="flex flex-col gap-1.5">
        <h3 className="text-caption uppercase tracking-wide text-fg-tertiary">
          {t('supervisor.recentActions')}
        </h3>
        {recent.length === 0 ? (
          <p className="text-body-sm text-fg-tertiary">{t('supervisor.noActions')}</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {recent.map((row) => (
              <li key={row.id} className="flex items-center gap-2 text-caption">
                <AlertCircle size={11} className={cn('shrink-0', row.variant === 'error' ? 'text-error' : 'text-accent')} />
                <span className="shrink-0 font-medium text-fg-secondary">{row.label}</span>
                <span className="min-w-0 flex-1 truncate text-fg-tertiary">{row.summary}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
