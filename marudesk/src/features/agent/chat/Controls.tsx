import { useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Loader2,
  Plus,
  Settings as SettingsIcon,
  Sparkles,
} from 'lucide-react';
import { Button } from '../../../components/ui';
import { formatElapsed } from '../../../hooks';
import { useI18n } from '../../../i18n/useI18n';
import type { TranslationKey } from '../../../i18n/messages';
import { cn } from '../../../lib/cn';
import {
  findModel,
  isBuiltinProviderId,
  providerLabel,
} from '../../../../shared/providers';
import type { AgentStatus } from '../../../../shared/agent';
import { openSettingsTab } from '../../settings/store';
import { useProvidersStore } from '../../providers/store';
import { ProviderGlyph } from '../../providers/ProviderGlyph';
import { useWorkspaceStore } from '../../workspace/store';
import { useWebPageStore } from '../../browser/store';
import { useAgentStore } from '../store';
import { ModelPalette } from '../ModelPalette';
import {
  formatContext,
  formatSelectedCaptures,
  formatUsageTitle,
  isBusy,
  STATUS_LABEL_KEY,
} from './format';

/* ── "+" context button ─────────────────────────────────────────────────── */

/**
 * The "+" button that opens the context popover. Shows a count badge when any
 * captures are currently selected — so the user can glance at the composer and
 * know context is already attached before hitting Send.
 */
export function ContextButton({
  buttonRef,
  open,
  onToggle,
}: {
  buttonRef: React.RefObject<HTMLButtonElement | null>;
  open: boolean;
  onToggle: () => void;
}) {
  const { locale, t } = useI18n();
  const selectedIds = useWebPageStore((s) => s.selectedCaptureIds);
  const selectedCount = selectedIds.size;

  return (
    <div className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        onClick={onToggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('agent.context.addContext')}
        title={t('agent.chat.addContextTitle')}
        className={cn(
          'size-7 flex items-center justify-center rounded transition-colors duration-fast',
          open
            ? 'bg-accent-subtle text-accent'
            : 'text-fg-tertiary hover:bg-surface-3 hover:text-fg-secondary',
        )}
      >
        <Plus size={16} />
      </button>
      {selectedCount > 0 ? (
        <span
          aria-label={formatSelectedCaptures(locale, selectedCount)}
          className={cn(
            'pointer-events-none absolute -top-1.5 -right-1.5',
            'flex items-center justify-center',
            'min-w-[16px] h-4 rounded-pill px-1',
            'bg-accent text-white text-[10px] font-medium tabular-nums leading-none',
          )}
        >
          {selectedCount}
        </span>
      ) : null}
    </div>
  );
}

/* ── usage meter ────────────────────────────────────────────────────────── */

/**
 * Token usage for the running conversation against the selected model's context
 * window — the Claude/Codex Desktop-style usage readout. Hidden until a turn has
 * actually consumed tokens.
 */
export function UsageMeter() {
  const { locale } = useI18n();
  const usage = useAgentStore((s) => s.chat.usage);
  const selectedModelKey = useProvidersStore((s) => s.selectedModelKey);
  const models = useProvidersStore((s) => s.models);
  if (usage.inputTokens === 0 && usage.outputTokens === 0 && usage.contextTokens === 0) return null;
  const ctx = findModel(models, selectedModelKey)?.contextWindow;
  // The gauge tracks live context-window occupancy (contextTokens), not the
  // cumulative input total — so it falls after a compaction instead of climbing.
  const pct = ctx ? Math.min(100, Math.round((usage.contextTokens / ctx) * 100)) : null;
  return (
    <span
      className="flex items-center gap-1.5 text-caption text-fg-tertiary tabular-nums shrink-0"
      title={formatUsageTitle(
        locale,
        usage.inputTokens.toLocaleString(),
        usage.outputTokens.toLocaleString(),
      )}
    >
      {pct !== null ? (
        <>
          <span aria-hidden className="h-1 w-8 rounded-pill bg-surface-3 overflow-hidden">
            <span className="block h-full bg-accent" style={{ width: `${pct}%` }} />
          </span>
          <span>{pct}%</span>
        </>
      ) : (
        <span>{formatContext(usage.contextTokens || usage.inputTokens)} tok</span>
      )}
    </span>
  );
}

/* ── provider / model bar ───────────────────────────────────────────────── */

/**
 * Model selector trigger (docs/agentic-chat-v4-design.md §A1): a compact chip
 * showing the current model + context window + key status that opens the
 * command-palette {@link ModelPalette}. The inline "no key" banner nudges to
 * Settings when the active provider has no usable auth.
 */
export function ProviderModelBar({ full }: { full?: boolean }) {
  const { t } = useI18n();
  const models = useProvidersStore((s) => s.models);
  const selectedModelKey = useProvidersStore((s) => s.selectedModelKey);
  const selectedModel = useProvidersStore((s) => s.selectedModel);
  const selectedProvider = useProvidersStore((s) => s.selectedProvider);
  const providerStatus = useProvidersStore((s) => s.providerStatus);
  const statusChecked = useProvidersStore((s) => s.statusChecked);
  const customProviders = useProvidersStore((s) => s.customProviders);
  const selectKeyProvider = useProvidersStore((s) => s.selectKeyProvider);

  const [open, setOpen] = useState(false);

  // The composer's `/model` command opens this palette via a window event, so the
  // command stays decoupled from the bar's local open state.
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener('marudesk:open-model-palette', onOpen);
    return () => window.removeEventListener('marudesk:open-model-palette', onOpen);
  }, []);

  const current = findModel(models, selectedModelKey);
  const hasKey = !!providerStatus.find((s) => s.id === selectedProvider)?.hasKey;

  return (
    <section className="shrink-0 px-3 py-2 border-b border-subtle">
      <div className={cn('relative', full && 'mx-auto w-full max-w-3xl')}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={open}
          className="w-full h-8 px-2.5 rounded border border-default hover:border-accent/70 bg-surface-page flex items-center gap-2 text-body-sm text-fg-primary transition-colors duration-fast group"
        >
          <ProviderGlyph
            provider={selectedProvider}
            label={providerLabel(selectedProvider, customProviders)}
            size={18}
          />
          <span className="truncate flex-1 text-left font-medium text-body-sm">{current?.label ?? selectedModel}</span>
          {current?.contextWindow ? (
            <span className="text-[0.6875rem] text-fg-tertiary/70 tabular-nums shrink-0 font-mono">
              {formatContext(current.contextWindow)}
            </span>
          ) : null}
          <span
            aria-hidden
            className={cn('size-1.5 rounded-pill shrink-0', hasKey ? 'bg-accent' : 'bg-fg-tertiary/30')}
          />
          <ChevronDown size={12} className="text-fg-tertiary/60 group-hover:text-fg-tertiary shrink-0 transition-colors duration-fast" />
        </button>

        {!hasKey && statusChecked && isBuiltinProviderId(selectedProvider) ? (
          <div className="mt-2 flex items-center justify-between gap-2 rounded border border-subtle bg-surface-2 px-2 py-1">
            <span className="text-caption text-fg-tertiary truncate">
              {t('agent.chat.noApiKeyBefore')}
              {providerLabel(selectedProvider, customProviders)}
              {t('agent.chat.noApiKeyAfter')}
            </span>
            <button
              type="button"
              onClick={() => {
                selectKeyProvider(selectedProvider);
                void openSettingsTab('providers');
              }}
              className="flex items-center gap-1 text-caption text-fg-tertiary hover:text-accent transition-colors duration-fast"
            >
              <SettingsIcon size={12} /> {t('activity.settings')}
            </button>
          </div>
        ) : null}
      </div>

      {open ? <ModelPalette onClose={() => setOpen(false)} /> : null}
    </section>
  );
}

/* ── status pill ────────────────────────────────────────────────────────── */

export function StatusPill({ status, elapsed = 0 }: { status: AgentStatus; elapsed?: number }) {
  const { t } = useI18n();
  const busy = isBusy(status);
  return (
    <span className="flex items-center gap-1.5 text-caption text-fg-tertiary tabular-nums">
      {busy ? (
        <Loader2 size={11} className="animate-spin text-accent shrink-0" />
      ) : (
        <span
          aria-hidden
          className={cn(
            'size-1.5 rounded-pill shrink-0',
            status === 'failed' ? 'bg-error' : status === 'completed' ? 'bg-accent' : 'bg-fg-tertiary/50',
          )}
        />
      )}
      {/* Announce only the label (not the per-second elapsed tick) so screen
          readers hear the turn lifecycle — Thinking → Working → Done — once. */}
      <span aria-live="polite">{t(STATUS_LABEL_KEY[status])}</span>
      {busy && elapsed > 0 ? (
        <span className="text-fg-tertiary/70">{formatElapsed(elapsed)}</span>
      ) : null}
    </span>
  );
}

/* ── empty state ────────────────────────────────────────────────────────── */

const SUGGESTION_KEYS: TranslationKey[] = [
  'agent.chat.suggestion.consoleError',
  'agent.chat.suggestion.network',
  'agent.chat.suggestion.layout',
];

export function EmptyState({
  hasWorkspace,
  onPick,
}: {
  hasWorkspace: boolean;
  onPick: (text: string) => void;
}) {
  const { t } = useI18n();
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace);
  return (
    <div className="flex flex-col items-center text-center gap-4 px-4 py-2">
      {/* Icon mark */}
      <div className="flex size-12 items-center justify-center rounded-lg bg-accent-subtle/60 ring-1 ring-accent/25">
        <Sparkles size={20} className="text-accent" />
      </div>

      <div className="flex flex-col items-center gap-1.5">
        <p className="text-body-sm font-medium text-fg-primary tracking-tight">{t('agent.chat.empty.title')}</p>
        <p className="text-caption text-fg-tertiary max-w-[264px] leading-relaxed">
          {hasWorkspace
            ? t('agent.chat.empty.workspace')
            : t('agent.chat.empty.noWorkspace')}
        </p>
      </div>

      {hasWorkspace ? (
        <div className="flex w-full max-w-[288px] flex-col items-stretch gap-1.5">
          {SUGGESTION_KEYS.map((key) => {
            const suggestion = t(key);
            return (
            <button
              key={key}
              type="button"
              onClick={() => onPick(suggestion)}
              className={cn(
                'group rounded-lg border border-subtle bg-surface-1 px-3 py-2 text-left',
                'text-caption text-fg-secondary',
                'hover:border-accent/50 hover:bg-surface-2 hover:text-fg-primary',
                'transition-colors duration-fast',
                'flex items-center gap-2',
              )}
            >
              <span className="flex-1">{suggestion}</span>
              <ChevronRight size={11} className="text-fg-tertiary/40 group-hover:text-fg-tertiary transition-colors duration-fast shrink-0" />
            </button>
            );
          })}
        </div>
      ) : (
        // No workspace yet: give the empty state a real next step instead of a
        // dead-end instruction (DESIGN.md §10 — empty states are a direct action).
        <Button
          variant="secondary"
          size="sm"
          leadingIcon={<FolderOpen size={14} />}
          onClick={() => void openWorkspace()}
        >
          {t('workspace.action.openFolder')}
        </Button>
      )}
    </div>
  );
}
