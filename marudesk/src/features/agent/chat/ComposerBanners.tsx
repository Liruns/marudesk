import { ListChecks, X } from 'lucide-react';
import { useI18n } from '../../../i18n/useI18n';
import { useAgentStore } from '../store';

/**
 * The composer's store-driven notices above the input: a local (client-side)
 * error banner, and the staged-message queue shown while messages are waiting
 * for the running turn(s) to finish. The queue is a real FIFO list — each row is
 * one staged message with its own remove button — so a user can line up several
 * follow-ups and they send one-at-a-time. Both read from the agent store
 * directly; the slash-info readout stays in the parent since it's component-local.
 */
export function ComposerBanners() {
  const { t } = useI18n();
  const localError = useAgentStore((s) => s.localError);
  const queuedPrompts = useAgentStore((s) => s.queuedPrompts);
  const removeQueuedPrompt = useAgentStore((s) => s.removeQueuedPrompt);

  return (
    <>
      {localError ? (
        <div className="rounded border border-subtle bg-error-subtle/40 px-3 py-1.5 text-caption text-fg-secondary break-words shadow-highlight">
          {localError}
        </div>
      ) : null}

      {queuedPrompts.length > 0 ? (
        <div className="chrome-panel flex flex-col gap-1 rounded px-2 py-1.5">
          <div className="flex items-center gap-1.5 px-1 text-caption text-fg-tertiary">
            <ListChecks size={12} className="shrink-0" />
            <span>{t('agent.chat.queuedPrompt')}</span>
            <span className="ml-auto rounded-pill bg-surface-2 px-1.5 tabular-nums text-fg-secondary">
              {queuedPrompts.length}
            </span>
          </div>
          {queuedPrompts.map((prompt, index) => (
            <div
              key={`${index}:${prompt}`}
              className="group flex items-start gap-2 rounded bg-surface-2/60 px-2 py-1"
            >
              <span className="mt-px shrink-0 text-caption text-fg-tertiary tabular-nums">
                {index + 1}
              </span>
              <span className="flex-1 min-w-0 line-clamp-2 text-caption text-fg-secondary break-words">
                {prompt}
              </span>
              <button
                type="button"
                onClick={() => removeQueuedPrompt(index)}
                aria-label={t('agent.chat.cancelQueued')}
                className="mt-px shrink-0 text-fg-tertiary opacity-0 transition-opacity duration-fast hover:text-fg-secondary group-hover:opacity-100"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}
