import { useState } from 'react';
import {
  ChevronDown,
  Code2,
  Download,
  Eraser,
  Eye,
  FileText,
  Hand,
  NotebookPen,
  Search,
  SlidersHorizontal,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { AgentMessage } from '../../../../shared/agent';
import type { AgentApprovalMode, ReasoningEffort } from '../../../../shared/settings';
import { useI18n } from '../../../i18n/useI18n';
import { useSettingsStore } from '../../settings/store';
import { useAgentStore } from '../store';
import { downloadTranscript, downloadTranscriptHtml } from './exportTranscript';
import { ApprovalToggle, EffortToggle, VerbosityToggle } from './Toggles';

/**
 * Transcript export — ONE control with a small menu, instead of two always-visible
 * format buttons cluttering the manage cluster. Opens upward (the cluster sits low,
 * near the composer) so it never clips the window's bottom edge.
 */
function ExportMenu({ messages }: { messages: readonly AgentMessage[] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const item =
    'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-caption text-fg-secondary hover:bg-surface-3 hover:text-fg-primary focus-visible:bg-surface-3 focus-visible:outline-none transition-colors duration-fast';
  return (
    <div className="relative" onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('agent.chat.export')}
        title={t('agent.chat.export')}
        className="flex items-center h-5 px-1.5 rounded-sm text-fg-tertiary hover:text-fg-secondary hover:bg-surface-3 transition-colors duration-fast"
      >
        <Download size={12} />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 bottom-full z-50 mb-1 min-w-[9.5rem] rounded-md chrome-panel py-1 shadow-card animate-scale-in"
        >
          <button role="menuitem" type="button" onClick={() => { setOpen(false); downloadTranscript(messages); }} className={item}>
            <FileText size={12} className="shrink-0" />
            {t('agent.chat.exportMd')}
          </button>
          <button role="menuitem" type="button" onClick={() => { setOpen(false); downloadTranscriptHtml(messages); }} className={item}>
            <Code2 size={12} className="shrink-0" />
            {t('agent.chat.exportHtml')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

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
      <ExportMenu messages={messages} />
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
 * Per-turn config (reasoning effort · approval mode), beside the model chip. It is
 * "set once, rarely change" config, so it stays collapsed behind a single Tune
 * button at EVERY width — the composer's action bar reads as one clean
 * `[+ · model · Tune] · Send` row instead of a busy strip of a six-segment effort
 * dial plus four cryptic approval icons. The Tune button still shows the active
 * approval glyph, so the current autonomy reads at a glance; one click opens the
 * (labelled) effort + approval dials. Keeping it width-independent also means the
 * composer never reflows its controls as the pane resizes.
 */
export function ComposerTurnToggles({ isReasoningModel }: { isReasoningModel: boolean }) {
  const approvalMode = useSettingsStore((s) => s.settings.agent.approvalMode);
  const reasoningEffort = useSettingsStore((s) => s.settings.agent.reasoningEffort);
  const updateSettings = useSettingsStore((s) => s.update);
  const setEffort = (effort: ReasoningEffort) => void updateSettings({ agent: { reasoningEffort: effort } });
  const setApproval = (mode: AgentApprovalMode) => void updateSettings({ agent: { approvalMode: mode } });
  return (
    <TunePopover
      isReasoningModel={isReasoningModel}
      reasoningEffort={reasoningEffort}
      approvalMode={approvalMode}
      onEffort={setEffort}
      onApproval={setApproval}
    />
  );
}

/** Active-mode glyph for the collapsed Tune button (so autonomy still reads at a glance). */
const APPROVAL_ICON: Record<AgentApprovalMode, LucideIcon> = {
  plan: NotebookPen,
  'read-only': Eye,
  ask: Hand,
  auto: Zap,
};

/**
 * The narrow-composer collapse of {@link ComposerTurnToggles}: a single button —
 * showing the active approval glyph so the current autonomy still reads at a glance
 * — that opens a small popover with the effort dial (reasoning models only) and the
 * approval dial. Opens UPWARD (the composer sits at the bottom edge).
 */
function TunePopover({
  isReasoningModel,
  reasoningEffort,
  approvalMode,
  onEffort,
  onApproval,
}: {
  isReasoningModel: boolean;
  reasoningEffort: ReasoningEffort;
  approvalMode: AgentApprovalMode;
  onEffort: (e: ReasoningEffort) => void;
  onApproval: (m: AgentApprovalMode) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ActiveGlyph = APPROVAL_ICON[approvalMode];
  return (
    <div className="relative" onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('agent.chat.tune')}
        title={t('agent.chat.tune')}
        className="chrome-panel-strong flex h-7 items-center gap-1 rounded-lg px-1.5 text-fg-tertiary hover:text-fg-secondary transition-colors duration-fast"
      >
        <SlidersHorizontal size={13} />
        <ActiveGlyph size={12} aria-hidden />
        <ChevronDown size={11} className="text-fg-quaternary" aria-hidden />
      </button>
      {open ? (
        <div
          role="menu"
          // Anchor the LEFT edge to the button and open rightward: the Tune button
          // sits at the left of the (narrow, ~360px dock) action bar, so a right-0
          // anchor pushed the wide 6-level effort dial off the dock's left edge,
          // over the canvas. left-0 keeps the popover inside the dock.
          className="absolute left-0 bottom-full z-50 mb-1 flex w-max max-w-[min(20rem,calc(100vw-1rem))] flex-col gap-2.5 rounded-lg chrome-panel p-2.5 shadow-card animate-scale-in"
        >
          {isReasoningModel ? (
            <div className="flex flex-col gap-1">
              <p className="text-micro uppercase tracking-wide text-fg-quaternary">{t('settings.agent.reasoning.label')}</p>
              <EffortToggle value={reasoningEffort} onChange={onEffort} />
            </div>
          ) : null}
          <div className="flex flex-col gap-1">
            <p className="text-micro uppercase tracking-wide text-fg-quaternary">{t('settings.agent.approval.label')}</p>
            <ApprovalToggle value={approvalMode} onChange={onApproval} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
