import { Eraser } from 'lucide-react';
import { useI18n } from '../../../i18n/useI18n';
import { useSettingsStore } from '../../settings/store';
import { useAgentStore } from '../store';
import { ApprovalToggle, EffortToggle, VerbosityToggle } from './Toggles';

/**
 * The composer footer's right-hand toggle cluster: reasoning-effort (shown only
 * for reasoning models), approval mode, response verbosity, and the "new
 * conversation" button. Reads its settings/agent state from the stores directly;
 * the parent only passes the three derived display flags.
 */
export function ComposerToggles({
  empty,
  busy,
  isReasoningModel,
}: {
  empty: boolean;
  busy: boolean;
  isReasoningModel: boolean;
}) {
  const { t } = useI18n();
  const verbosity = useAgentStore((s) => s.verbosity);
  const setVerbosity = useAgentStore((s) => s.setVerbosity);
  const resetChat = useAgentStore((s) => s.resetChat);
  const approvalMode = useSettingsStore((s) => s.settings.agent.approvalMode);
  const reasoningEffort = useSettingsStore((s) => s.settings.agent.reasoningEffort);
  const updateSettings = useSettingsStore((s) => s.update);

  return (
    <div className="chrome-panel-strong flex items-center gap-px rounded p-0.5 shrink-0">
      {isReasoningModel ? (
        <>
          <EffortToggle
            value={reasoningEffort}
            onChange={(effort) => void updateSettings({ agent: { reasoningEffort: effort } })}
          />
          {/* Divider */}
          <span aria-hidden className="mx-0.5 h-3.5 w-px bg-surface-3" />
        </>
      ) : null}
      <ApprovalToggle
        value={approvalMode}
        onChange={(mode) => void updateSettings({ agent: { approvalMode: mode } })}
      />
      {!empty ? (
        <>
          <span aria-hidden className="mx-0.5 h-3.5 w-px bg-surface-3" />
          <VerbosityToggle value={verbosity} onChange={setVerbosity} />
        </>
      ) : null}
      {!busy && !empty ? (
        <>
          <span aria-hidden className="mx-0.5 h-3.5 w-px bg-surface-3" />
          <button
            type="button"
            onClick={() => void resetChat()}
            className="flex items-center gap-1 h-5 px-1.5 rounded-sm text-caption text-fg-tertiary hover:text-fg-secondary hover:bg-surface-3 transition-colors duration-fast"
            title={t('agent.chat.newConversation')}
          >
            <Eraser size={11} />
            <span className="text-[10px] leading-none">{t('agent.chat.new')}</span>
          </button>
        </>
      ) : null}
    </div>
  );
}
