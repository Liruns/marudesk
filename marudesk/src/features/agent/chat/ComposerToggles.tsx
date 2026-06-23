import { Code2, Download, Eraser, Search } from 'lucide-react';
import { useI18n } from '../../../i18n/useI18n';
import { useSettingsStore } from '../../settings/store';
import { useAgentStore } from '../store';
import { downloadTranscript, downloadTranscriptHtml } from './exportTranscript';
import { ApprovalToggle, EffortToggle, VerbosityToggle } from './Toggles';

/**
 * Transcript-management cluster, top-right of the composer: response verbosity,
 * transcript search, export (md / html), and "new conversation". These act on the
 * conversation as a whole, so they sit ABOVE the input — and only once there IS a
 * conversation. With an empty chat they render nothing, so a fresh composer shows
 * no top toolbar at all. The per-turn config (model · reasoning · approval) lives
 * in the action bar next to the prompt instead — see {@link ComposerTurnToggles}.
 */
export function ComposerToggles({
  empty,
  busy,
  onToggleSearch,
}: {
  empty: boolean;
  busy: boolean;
  onToggleSearch?: () => void;
}) {
  const { t } = useI18n();
  const verbosity = useAgentStore((s) => s.verbosity);
  const setVerbosity = useAgentStore((s) => s.setVerbosity);
  const resetChat = useAgentStore((s) => s.resetChat);
  const messages = useAgentStore((s) => s.chat.messages);

  // Nothing to view or manage until a transcript exists.
  if (empty) return null;

  return (
    <div className="chrome-panel-strong flex items-center gap-px rounded-lg p-0.5 shrink-0">
      <VerbosityToggle value={verbosity} onChange={setVerbosity} />
      <span aria-hidden className="mx-0.5 h-3.5 w-px bg-surface-3" />
      {onToggleSearch ? (
        <button
          type="button"
          onClick={onToggleSearch}
          aria-label={t('agent.chat.search.open')}
          title={t('agent.chat.search.open')}
          className="flex items-center h-5 px-1.5 rounded-sm text-fg-tertiary hover:text-fg-secondary hover:bg-surface-3 transition-colors duration-fast"
        >
          <Search size={12} />
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => downloadTranscript(messages)}
        aria-label={t('agent.chat.export')}
        title={t('agent.chat.export')}
        className="flex items-center h-5 px-1.5 rounded-sm text-fg-tertiary hover:text-fg-secondary hover:bg-surface-3 transition-colors duration-fast"
      >
        <Download size={12} />
      </button>
      <button
        type="button"
        onClick={() => downloadTranscriptHtml(messages)}
        aria-label={t('agent.chat.exportHtml')}
        title={t('agent.chat.exportHtml')}
        className="flex items-center h-5 px-1.5 rounded-sm text-fg-tertiary hover:text-fg-secondary hover:bg-surface-3 transition-colors duration-fast"
      >
        <Code2 size={12} />
      </button>
      {!busy ? (
        <>
          <span aria-hidden className="mx-0.5 h-3.5 w-px bg-surface-3" />
          <button
            type="button"
            onClick={() => void resetChat()}
            className="flex items-center gap-1 h-5 px-1.5 rounded-sm text-caption text-fg-tertiary hover:text-fg-secondary hover:bg-surface-3 transition-colors duration-fast"
            title={t('agent.chat.newConversation')}
          >
            <Eraser size={12} />
            <span className="text-micro leading-none">{t('agent.chat.new')}</span>
          </button>
        </>
      ) : null}
    </div>
  );
}

/**
 * Per-turn config, grouped with the model chip in the action bar (just above the
 * prompt): the reasoning-effort dial (reasoning models only) and the approval
 * mode. Co-locating them with the model makes "which model · how hard it thinks ·
 * how much it may do" read as one decision in one place, instead of being split
 * between the top toolbar and the bottom action bar.
 */
export function ComposerTurnToggles({ isReasoningModel }: { isReasoningModel: boolean }) {
  const approvalMode = useSettingsStore((s) => s.settings.agent.approvalMode);
  const reasoningEffort = useSettingsStore((s) => s.settings.agent.reasoningEffort);
  const updateSettings = useSettingsStore((s) => s.update);
  return (
    <div className="chrome-panel-strong flex items-center gap-px rounded-lg p-0.5 shrink-0">
      {isReasoningModel ? (
        <>
          <EffortToggle
            value={reasoningEffort}
            onChange={(effort) => void updateSettings({ agent: { reasoningEffort: effort } })}
          />
          <span aria-hidden className="mx-0.5 h-3.5 w-px bg-surface-3" />
        </>
      ) : null}
      <ApprovalToggle
        value={approvalMode}
        onChange={(mode) => void updateSettings({ agent: { approvalMode: mode } })}
      />
    </div>
  );
}
