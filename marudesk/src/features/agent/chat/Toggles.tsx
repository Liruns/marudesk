import {
  Brain,
  Eye,
  Hand,
  List,
  ListTree,
  NotebookPen,
  TextQuote,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../../../lib/cn';
import { useI18n } from '../../../i18n/useI18n';
import type { TranslationKey } from '../../../i18n/messages';
import type { AgentApprovalMode, ReasoningEffort } from '../../../../shared/settings';
import type { TranscriptVerbosity } from '../store';

const VERBOSITY_OPTS: { value: TranscriptVerbosity; icon: LucideIcon; labelKey: TranslationKey }[] = [
  { value: 'summary', icon: TextQuote, labelKey: 'agent.chat.verbosity.summary' },
  { value: 'normal', icon: List, labelKey: 'agent.chat.verbosity.normal' },
  { value: 'verbose', icon: ListTree, labelKey: 'agent.chat.verbosity.verbose' },
];

/**
 * Transcript detail dial (Claude Desktop parity). Summary shows only the agent's
 * prose answers; Normal keeps tool/thinking steps collapsed; Verbose expands them.
 * A compact 3-way segmented control sitting in the composer footer.
 */
export function VerbosityToggle({
  value,
  onChange,
}: {
  value: TranscriptVerbosity;
  onChange: (v: TranscriptVerbosity) => void;
}) {
  const { t } = useI18n();
  return (
    <div
      role="group"
      aria-label={t('agent.chat.transcriptDetail')}
      className="flex items-center gap-0.5"
    >
      {VERBOSITY_OPTS.map((opt) => {
        const Icon = opt.icon;
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            aria-pressed={active}
            title={t(opt.labelKey)}
            className={cn(
              'flex items-center justify-center size-5 rounded-sm transition-colors duration-fast',
              active
                ? 'bg-surface-3 text-fg-primary'
                : 'text-fg-tertiary hover:text-fg-secondary',
            )}
          >
            <Icon size={12} />
          </button>
        );
      })}
    </div>
  );
}

const APPROVAL_OPTS: { value: AgentApprovalMode; icon: LucideIcon; labelKey: TranslationKey }[] = [
  { value: 'plan', icon: NotebookPen, labelKey: 'agent.chat.approval.plan' },
  { value: 'read-only', icon: Eye, labelKey: 'agent.chat.approval.readOnly' },
  { value: 'ask', icon: Hand, labelKey: 'agent.chat.approval.ask' },
  { value: 'auto', icon: Zap, labelKey: 'agent.chat.approval.auto' },
];

/**
 * Inline approval-mode toggle (v3 §5-D) — the same three modes as Settings →
 * Agent, surfaced beside the composer so autonomy can be dialed without leaving
 * the chat. Writes straight to the persisted setting; the loop reads it per turn.
 */
export function ApprovalToggle({
  value,
  onChange,
}: {
  value: AgentApprovalMode;
  onChange: (v: AgentApprovalMode) => void;
}) {
  const { t } = useI18n();
  return (
    <div
      role="group"
      aria-label={t('settings.agent.approval.label')}
      className="flex items-center gap-0.5"
    >
      {APPROVAL_OPTS.map((opt) => {
        const Icon = opt.icon;
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            aria-pressed={active}
            title={t(opt.labelKey)}
            className={cn(
              'flex items-center justify-center size-5 rounded-sm transition-colors duration-fast',
              active
                ? 'bg-surface-3 text-fg-primary'
                : 'text-fg-tertiary hover:text-fg-secondary',
            )}
          >
            <Icon size={12} />
          </button>
        );
      })}
    </div>
  );
}

const EFFORT_OPTS: {
  value: ReasoningEffort;
  shortKey: TranslationKey;
  labelKey: TranslationKey;
}[] = [
  { value: 'minimal', shortKey: 'agent.chat.effort.minShort', labelKey: 'agent.chat.effort.minimal' },
  { value: 'low', shortKey: 'agent.chat.effort.lowShort', labelKey: 'agent.chat.effort.low' },
  { value: 'medium', shortKey: 'agent.chat.effort.mediumShort', labelKey: 'agent.chat.effort.medium' },
  { value: 'high', shortKey: 'agent.chat.effort.highShort', labelKey: 'agent.chat.effort.high' },
  { value: 'xhigh', shortKey: 'agent.chat.effort.xhighShort', labelKey: 'agent.chat.effort.xhigh' },
  { value: 'max', shortKey: 'agent.chat.effort.maxShort', labelKey: 'agent.chat.effort.max' },
];

/**
 * Inline reasoning-effort dial — shown only when the selected model is a
 * reasoning model. Mirrors {@link ApprovalToggle}: writes the persisted
 * `agent.reasoningEffort`, which the loop maps to each provider's native thinking
 * knob per turn. A leading Brain icon marks the group; the four levels use short
 * text labels (vs. the icon-only Approval/Verbosity groups) so they stay legible.
 */
export function EffortToggle({
  value,
  onChange,
}: {
  value: ReasoningEffort;
  onChange: (v: ReasoningEffort) => void;
}) {
  const { t } = useI18n();
  return (
    <div
      role="group"
      aria-label={t('settings.agent.reasoning.label')}
      className="flex items-center gap-0.5"
    >
      <Brain size={12} className="mx-0.5 text-fg-quaternary shrink-0" aria-hidden />
      {EFFORT_OPTS.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            aria-pressed={active}
            title={t(opt.labelKey)}
            className={cn(
              'flex items-center justify-center h-5 px-1.5 rounded-sm text-micro font-medium leading-none transition-colors duration-fast',
              active
                ? 'bg-surface-3 text-fg-primary'
                : 'text-fg-tertiary hover:text-fg-secondary',
            )}
          >
            {t(opt.shortKey)}
          </button>
        );
      })}
    </div>
  );
}
