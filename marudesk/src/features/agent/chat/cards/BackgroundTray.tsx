import { useState } from 'react';
import { AlertCircle, Ban, CheckCircle2, Loader2 } from 'lucide-react';
import { Badge } from '../../../../components/ui';
import { useI18n } from '../../../../i18n/useI18n';
import { cn } from '../../../../lib/cn';
import type { BackgroundTask, BackgroundStatus } from '../../../../../shared/agent';
import { useAgentStore } from '../../store';

/* ── background agents (detached spawn tray) ─────────────────────────────── */

const BG_STATUS_ICON: Record<BackgroundStatus, typeof Loader2> = {
  running: Loader2,
  done: CheckCircle2,
  error: AlertCircle,
  cancelled: Ban,
};

/**
 * The detached background-agent tray (docs/background-agent-design.md §10). A
 * read-only projection of `chat.background`: each task shows its label, model,
 * status, and — when finished — an expandable final report. The model collects
 * results via collect_background_agent; this surface just keeps the user aware.
 */
export function BackgroundTray({ tasks }: { readonly tasks: readonly BackgroundTask[] }) {
  const { t } = useI18n();
  const cancelBackground = useAgentStore((s) => s.cancelBackground);
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set());
  if (!tasks || tasks.length === 0) return null;
  const toggle = (id: string) =>
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-caption uppercase tracking-wider text-fg-tertiary">
        Background agents
      </span>
      {tasks.map((task) => {
        const Icon = BG_STATUS_ICON[task.status];
        const body = task.status === 'done' ? task.result : task.error;
        const expandable = task.status !== 'running' && !!body;
        const open = openIds.has(task.id);
        return (
          <div key={task.id} className="rounded border border-subtle bg-surface-2">
            <div className="flex w-full items-center">
              <button
                type="button"
                disabled={!expandable}
                onClick={() => expandable && toggle(task.id)}
                className={cn(
                  'flex flex-1 items-center gap-2 px-2.5 py-1.5 text-left min-w-0',
                  expandable && 'hover:bg-surface-3',
                )}
              >
                <Icon
                  size={13}
                  className={cn(
                    'shrink-0',
                    task.status === 'running' && 'animate-spin text-fg-tertiary',
                    task.status === 'done' && 'text-success',
                    task.status === 'error' && 'text-error',
                    task.status === 'cancelled' && 'text-fg-tertiary',
                  )}
                />
                <span className="truncate text-body-sm text-fg-primary">{task.label}</span>
                <Badge variant="neutral">
                  {task.provider}/{task.model}
                </Badge>
                <span className="ml-auto shrink-0 text-caption text-fg-tertiary">{task.status}</span>
              </button>
              {task.status === 'running' ? (
                <button
                  type="button"
                  onClick={() => void cancelBackground(task.id)}
                  title={t('agent.chat.background.cancelTitle')}
                  aria-label={t('agent.chat.background.cancelTitle')}
                  className="shrink-0 px-2 py-1.5 text-fg-tertiary hover:text-error transition-colors duration-fast"
                >
                  <Ban size={13} />
                </button>
              ) : null}
            </div>
            {expandable && open ? (
              <div className="border-t border-subtle px-2.5 py-1.5 text-body-sm text-fg-secondary whitespace-pre-wrap break-words">
                {body}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
