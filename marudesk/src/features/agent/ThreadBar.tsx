import { useEffect, useState } from 'react';
import { Loader2, Plus, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import type { ThreadSummary } from '../../../shared/agent';

/**
 * Thread switcher (Stage 12-B-2). Tabs for the open conversation threads — click
 * to switch, ✕ to close, + to start a new one. The active thread drives the main
 * chat (switching emits its state). Main owns the registry; this is a projection
 * fed by `agent:threads` (pushed on every emit + on structure changes). Hidden
 * until there's more than one thread, so the single-chat case is unchanged.
 */
export function ThreadBar() {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.marudesk
      .invoke('agent:list-threads')
      .then(setThreads)
      .catch(() => {});
    const off = window.marudesk.on('agent:threads', (list: ThreadSummary[]) => setThreads(list));
    return off;
  }, []);

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

  const newThread = () => run(() => window.marudesk.invoke('agent:new-thread'));
  const switchTo = (id: string) => run(() => window.marudesk.invoke('agent:switch-thread', { id }));
  const close = (id: string) => run(() => window.marudesk.invoke('agent:close-thread', { id }));

  // Single-thread case: just the "+" affordance, kept unobtrusive.
  const multi = threads.length > 1;

  return (
    <div className="flex items-center gap-1 px-2 py-1 border-b border-subtle overflow-x-auto">
      {multi &&
        threads.map((t) => (
          <div
            key={t.id}
            className={cn(
              'group flex items-center gap-1.5 rounded px-2 py-1 text-caption max-w-44 shrink-0 cursor-pointer',
              t.active ? 'bg-surface-2 text-fg-primary' : 'text-fg-tertiary hover:bg-surface-1',
            )}
            onClick={() => !t.active && void switchTo(t.id)}
            title={t.title}
          >
            {t.busy ? (
              <Loader2 size={11} className="shrink-0 animate-spin text-accent" />
            ) : (
              <span className={cn('shrink-0 size-1.5 rounded-full', t.active ? 'bg-accent' : 'bg-fg-tertiary/40')} />
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
              className="shrink-0 opacity-0 group-hover:opacity-100 text-fg-tertiary hover:text-error disabled:opacity-0"
            >
              <X size={11} />
            </button>
          </div>
        ))}
      <button
        type="button"
        onClick={() => void newThread()}
        disabled={busy}
        aria-label="New thread"
        title="New thread"
        className="shrink-0 flex items-center gap-1 rounded px-1.5 py-1 text-caption text-fg-tertiary hover:bg-surface-1 hover:text-fg-primary disabled:opacity-50"
      >
        <Plus size={12} />
        {!multi && <span>New thread</span>}
      </button>
    </div>
  );
}
