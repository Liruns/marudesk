import { History, X } from 'lucide-react';
import { useI18n } from '../../../i18n/useI18n';
import { useAgentStore } from '../store';

/**
 * The composer's two store-driven notices above the input: a local (client-side)
 * error banner, and the "queued prompt" banner shown when a message is waiting
 * for the running turn to finish (with a cancel button). Both read from the
 * agent store directly; the slash-info readout stays in the parent since it's
 * component-local UI state.
 */
export function ComposerBanners() {
  const { t } = useI18n();
  const localError = useAgentStore((s) => s.localError);
  const queuedPrompt = useAgentStore((s) => s.queuedPrompt);
  const setQueuedPrompt = useAgentStore((s) => s.setQueuedPrompt);

  return (
    <>
      {localError ? (
        <div className="rounded border border-subtle bg-error-subtle/40 px-3 py-1.5 text-caption text-fg-secondary break-words shadow-highlight">
          {localError}
        </div>
      ) : null}

      {queuedPrompt ? (
        <div className="chrome-panel flex items-start gap-2 rounded px-3 py-1.5">
          <History size={12} className="mt-0.5 shrink-0 text-fg-tertiary" />
          <span className="flex-1 min-w-0 text-caption text-fg-secondary break-words">
            <span className="text-fg-tertiary">{t('agent.chat.queuedPrompt')}</span>{' '}
            {queuedPrompt}
          </span>
          <button
            type="button"
            onClick={() => setQueuedPrompt(null)}
            aria-label={t('agent.chat.cancelQueued')}
            className="shrink-0 text-fg-tertiary hover:text-fg-secondary transition-colors duration-fast"
          >
            <X size={12} />
          </button>
        </div>
      ) : null}
    </>
  );
}
