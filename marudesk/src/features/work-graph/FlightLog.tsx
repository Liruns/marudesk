import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, MessagesSquare, X } from 'lucide-react';
import type {
  AgentChatState,
  AgentMessage,
  AgentTextPart,
  AgentThreadEvent,
} from '../../../shared/agent';
import type { Task } from '../../../shared/work-os';
import type { WorkspaceId } from '../../../shared/workspace';
import { Badge, Spinner } from '../../components/ui';
import { useI18n } from '../../i18n/useI18n';
import { cn } from '../../lib/cn';
import { PaletteOverlay } from '../commands/PaletteOverlay';
import { isBusy } from '../agent/chat/format';
import { useWorkGraphStore } from './store';
import { taskThreadEntries } from './taskThreads';
import { useFlightLogStore } from './flight-log-store';
import { STATUS_BADGE, STATUS_LABEL_KEY } from './status';

/**
 * Flight Log — the cross-node transcript view (docs/mission-control-redesign.md,
 * Phase 2b). With each Task owning its own conversation in the Instrument Dock,
 * this overlay gathers every task's chat in one place so the flight-level thread
 * of work is never lost: skim each node's transcript, then jump straight to the
 * task to read or continue it. A read-only projection — it fetches each thread's
 * snapshot and follows its live stream, but all sending happens in the dock.
 */

/** Cap a single message preview so one long answer can't dominate the log. */
const PREVIEW_CHARS = 1200;

type Convo = { taskId: string; threadId: string; workspaceId?: WorkspaceId; task: Task };

function messageText(m: AgentMessage): string {
  return m.parts
    .filter((p): p is AgentTextPart => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
    .trim();
}

/** Title-bar trigger; only present once a flight (graph) exists. */
export function FlightLogButton() {
  const { t } = useI18n();
  const graph = useWorkGraphStore((s) => s.graph);
  const open = useFlightLogStore((s) => s.open);
  const toggle = useFlightLogStore((s) => s.toggle);
  if (!graph) return null;
  return (
    <button
      type="button"
      data-tour="flight-log"
      onClick={toggle}
      aria-label={t('flightLog.title')}
      aria-pressed={open}
      title={t('command.toggleFlightLog.hint')}
      className={cn(
        'no-drag inline-flex h-6 items-center justify-center rounded-md px-1.5',
        'text-fg-tertiary transition-colors duration-fast hover:bg-surface-3 hover:text-fg-secondary',
        'focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none',
        open && 'bg-surface-3 text-fg-secondary',
      )}
    >
      <MessagesSquare size={13} />
    </button>
  );
}

/** Outer mount: renders the overlay body only while open (a fresh body per open). */
export function FlightLog() {
  const open = useFlightLogStore((s) => s.open);
  const hide = useFlightLogStore((s) => s.hide);
  if (!open) return null;
  return <FlightLogBody onClose={hide} />;
}

function FlightLogBody({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const graph = useWorkGraphStore((s) => s.graph);
  const [states, setStates] = useState<Record<string, AgentChatState>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  // Starts true and flips false in the fetch's .then — no synchronous setState in
  // the effect body (this body is freshly mounted each time the log opens).
  const [loading, setLoading] = useState(true);

  // Tasks that already own a conversation thread, joined to their graph node.
  const convos = useMemo<Convo[]>(() => {
    if (!graph) return [];
    const tasks = new Map(graph.tasks.map((t) => [t.id, t] as const));
    const out: Convo[] = [];
    for (const e of taskThreadEntries()) {
      const task = tasks.get(e.taskId);
      if (task) out.push({ taskId: e.taskId, threadId: e.threadId, workspaceId: e.workspaceId, task });
    }
    return out;
  }, [graph]);

  // Fetch each thread's snapshot, then follow its live stream so counts and
  // transcripts stay fresh while a task runs in the background.
  useEffect(() => {
    let cancelled = false;
    const tracked = new Set(convos.map((c) => c.threadId));
    void Promise.all(
      convos.map(async (c) => {
        try {
          const state = await window.marudesk.invoke('agent:snapshot', {
            ...(c.workspaceId ? { workspaceId: c.workspaceId } : {}),
            threadId: c.threadId,
          });
          return [c.threadId, state] as const;
        } catch {
          return null;
        }
      }),
    ).then((pairs) => {
      if (cancelled) return;
      const next: Record<string, AgentChatState> = {};
      for (const p of pairs) if (p) next[p[0]] = p[1];
      setStates(next);
      setLoading(false);
    });
    const off = window.marudesk.on('agent:thread-event', (ev: AgentThreadEvent) => {
      if (!tracked.has(ev.threadId)) return;
      setStates((prev) => ({ ...prev, [ev.threadId]: ev.state }));
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [convos]);

  const goToTask = (taskId: string) => {
    useWorkGraphStore.getState().selectTask(taskId);
    onClose();
  };

  return (
    <PaletteOverlay ariaLabel={t('flightLog.title')} onClose={onClose} className="max-w-2xl">
        <header className="flex items-center gap-2 border-b border-subtle px-4 py-3">
          <MessagesSquare size={15} className="text-accent" />
          <h2 className="text-body-sm font-medium text-fg-primary">{t('flightLog.title')}</h2>
          <span className="text-caption text-fg-tertiary">
            {t(convos.length === 1 ? 'flightLog.count.one' : 'flightLog.count.other').replace(
              '{n}',
              String(convos.length),
            )}
          </span>
          <button
            type="button"
            aria-label={t('flightLog.close')}
            onClick={onClose}
            className="ml-auto grid h-6 w-6 place-items-center rounded text-fg-tertiary hover:bg-surface-3 hover:text-fg-primary focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none transition-colors duration-fast"
          >
            <X size={14} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {loading && convos.length === 0 ? (
            <div className="grid place-items-center py-10">
              <Spinner size={16} />
            </div>
          ) : convos.length === 0 ? (
            <p className="px-3 py-10 text-center text-caption text-fg-tertiary">
              {t('flightLog.empty')}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {convos.map((c) => {
                const state = states[c.threadId];
                const messages = state?.messages ?? [];
                const isOpen = expanded === c.threadId;
                return (
                  <li key={c.threadId} className="overflow-hidden rounded-md border border-subtle bg-surface-1">
                    <div className="flex items-center gap-2 px-3 py-2">
                      <button
                        type="button"
                        onClick={() => setExpanded(isOpen ? null : c.threadId)}
                        aria-expanded={isOpen}
                        className="flex min-w-0 flex-1 items-center gap-2 rounded text-left focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
                      >
                        <Badge variant={STATUS_BADGE[c.task.status]}>{t(STATUS_LABEL_KEY[c.task.status])}</Badge>
                        <span className="truncate text-body-sm text-fg-primary" title={c.task.title}>{c.task.title}</span>
                        <span className="shrink-0 text-caption tabular-nums text-fg-tertiary">{t('flightLog.msg').replace('{n}', String(messages.length))}</span>
                        {state && isBusy(state.status) ? <Spinner size={11} /> : null}
                      </button>
                      <button
                        type="button"
                        onClick={() => goToTask(c.taskId)}
                        title={t('flightLog.openTitle')}
                        className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-caption text-fg-secondary hover:bg-surface-3 hover:text-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none transition-colors duration-fast"
                      >
                        {t('flightLog.open')}
                        <ArrowRight size={12} />
                      </button>
                    </div>
                    {isOpen ? (
                      <div className="space-y-2 border-t border-subtle px-3 py-2">
                        {messages.length === 0 ? (
                          <p className="text-caption text-fg-tertiary">{t('flightLog.noMessages')}</p>
                        ) : (
                          messages.map((m) => {
                            const text = messageText(m);
                            if (!text) return null;
                            const clipped = text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
                            return (
                              <p key={m.id} className="text-caption leading-relaxed">
                                <span
                                  className={cn(
                                    'mr-1.5 font-medium',
                                    m.role === 'user' ? 'text-accent' : 'text-fg-secondary',
                                  )}
                                >
                                  {m.role === 'user' ? t('flightLog.role.you') : t('flightLog.role.agent')}
                                </span>
                                <span className="whitespace-pre-wrap break-words text-fg-secondary">{clipped}</span>
                              </p>
                            );
                          })
                        )}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
    </PaletteOverlay>
  );
}
