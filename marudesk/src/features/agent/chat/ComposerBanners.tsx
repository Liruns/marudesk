import { useState } from 'react';
import { AlertTriangle, ListChecks, X } from 'lucide-react';
import { useI18n } from '../../../i18n/useI18n';
import { toast } from '../../../lib/toast';
import { useSettingsStore } from '../../settings/store';
import { useAgentBusy, useAgentStore } from '../store';
import { useContextUsage } from '../useContextUsage';

/** Show the "almost full" compaction nudge at/above this context occupancy. */
const CONTEXT_NUDGE_PCT = 90;

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
  const compact = useAgentStore((s) => s.compact);
  const busy = useAgentBusy();
  const usage = useContextUsage();
  const autoCompact = useSettingsStore((s) => s.settings.agent.autoCompact.enabled);
  const [compacting, setCompacting] = useState(false);

  // Nudge the user to free context once the window is nearly full — but only in
  // manual mode: with auto-compact on, the agent already compacts past its own
  // threshold once a turn settles, so a manual prompt would be redundant noise.
  // Self-clearing: a successful compaction drops contextTokens, so the banner
  // vanishes on its own.
  const showNudge = !autoCompact && usage?.pct != null && usage.pct >= CONTEXT_NUDGE_PCT;

  const runCompact = () => {
    if (busy || compacting) return;
    setCompacting(true);
    toast({
      title: t('agent.chat.toast.compacting.title'),
      description: t('agent.chat.toast.compacting.description'),
    });
    void compact()
      .then((res) => {
        if (res.ok) {
          toast({
            title: t('agent.chat.toast.compacted.title'),
            description: t('agent.chat.toast.compacted.description'),
          });
        } else {
          toast({
            title: t('agent.chat.toast.compactFailed.title'),
            description: res.reason ?? t('agent.chat.toast.unknownError'),
            variant: 'error',
          });
        }
      })
      .finally(() => setCompacting(false));
  };

  return (
    <>
      {localError ? (
        <div className="rounded border border-subtle bg-error-subtle/40 px-3 py-1.5 text-caption text-fg-secondary break-words shadow-highlight">
          {localError}
        </div>
      ) : null}

      {showNudge ? (
        <div className="flex items-center gap-2 rounded border border-warning/40 bg-warning-subtle/40 px-3 py-1.5 text-caption text-fg-secondary shadow-highlight">
          <AlertTriangle size={12} className="shrink-0 text-warning" />
          <span className="flex-1 min-w-0">
            {t('agent.chat.contextNudge.body')} {usage?.pct}%
          </span>
          <button
            type="button"
            onClick={runCompact}
            disabled={busy || compacting}
            className="shrink-0 rounded px-1.5 py-0.5 font-medium text-warning hover:bg-warning-subtle/60 disabled:opacity-40 transition-colors duration-fast"
          >
            {t('agent.chat.contextNudge.compact')}
          </button>
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
