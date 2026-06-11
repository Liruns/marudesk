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
import { useAgentStore, useThreadModelKey } from '../store';
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
  const modelKey = useThreadModelKey();
  const models = useProvidersStore((s) => s.models);
  if (usage.inputTokens === 0 && usage.outputTokens === 0 && usage.contextTokens === 0) return null;
  const ctx = findModel(models, modelKey)?.contextWindow;
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

/* ── provider / model selector ──────────────────────────────────────────── */

/**
 * Compact model selector that lives INSIDE the composer's action bar (not pinned
 * as a separate cramped strip at the top). A small chip — provider glyph + model
 * name + a key-status dot — that opens the command-palette {@link ModelPalette}.
 * Keeping it in the input area keeps the chat header clean and the control close
 * to where the user is typing. The `/model` command still opens the palette via
 * a window event, so it stays decoupled from this chip's local open state.
 */
export function ComposerModelButton() {
  const models = useProvidersStore((s) => s.models);
  // Per-thread: the chip shows (and the palette pins) the ACTIVE thread's model.
  const modelKey = useThreadModelKey();
  const setThreadModelKey = useAgentStore((s) => s.setThreadModelKey);
  const selectedModel = useProvidersStore((s) => s.selectedModel);
  const selectedProvider = useProvidersStore((s) => s.selectedProvider);
  const providerStatus = useProvidersStore((s) => s.providerStatus);
  const customProviders = useProvidersStore((s) => s.customProviders);

  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener('marudesk:open-model-palette', onOpen);
    return () => window.removeEventListener('marudesk:open-model-palette', onOpen);
  }, []);

  const current = findModel(models, modelKey);
  const provider = current?.provider ?? selectedProvider;
  const status = providerStatus.find((s) => s.id === provider);
  const hasAuth = !!status?.hasKey || !!status?.oauth;
  const label = current?.label ?? selectedModel;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={label}
        className="group flex h-7 min-w-0 max-w-[13rem] items-center gap-1.5 rounded-md px-1.5 text-fg-secondary transition-colors duration-fast hover:bg-surface-3 hover:text-fg-primary"
      >
        <ProviderGlyph
          provider={provider}
          label={providerLabel(provider, customProviders)}
          size={15}
        />
        <span className="truncate text-caption font-medium">{label}</span>
        {!hasAuth ? (
          <span aria-hidden className="size-1.5 shrink-0 rounded-pill bg-warning" />
        ) : null}
        <ChevronDown
          size={11}
          className="shrink-0 text-fg-tertiary/60 transition-colors duration-fast group-hover:text-fg-tertiary"
        />
      </button>
      {open ? (
        <ModelPalette
          onClose={() => setOpen(false)}
          selectedKey={modelKey}
          onPick={setThreadModelKey}
        />
      ) : null}
    </>
  );
}

/**
 * Inline "no API key" nudge for the composer — shown just above the input when
 * the active provider has no usable auth, linking straight to its Settings card.
 */
export function ProviderKeyNudge() {
  const { t } = useI18n();
  const models = useProvidersStore((s) => s.models);
  const modelKey = useThreadModelKey();
  const selectedProvider = useProvidersStore((s) => s.selectedProvider);
  const providerStatus = useProvidersStore((s) => s.providerStatus);
  const statusChecked = useProvidersStore((s) => s.statusChecked);
  const customProviders = useProvidersStore((s) => s.customProviders);
  const selectKeyProvider = useProvidersStore((s) => s.selectKeyProvider);

  // Nudge for the ACTIVE THREAD's provider — a thread pinned to a since-
  // disconnected provider must surface that, not the global selection's state.
  const provider = findModel(models, modelKey)?.provider ?? selectedProvider;
  const status = providerStatus.find((s) => s.id === provider);
  const hasAuth = !!status?.hasKey || !!status?.oauth;
  if (hasAuth || !statusChecked || !isBuiltinProviderId(provider)) return null;

  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-subtle/80 bg-surface-2/70 px-3 py-1.5 shadow-card">
      <span className="truncate text-caption text-fg-tertiary">
        {t('agent.chat.noApiKeyBefore')}
        {providerLabel(provider, customProviders)}
        {t('agent.chat.noApiKeyAfter')}
      </span>
      <button
        type="button"
        onClick={() => {
          selectKeyProvider(provider);
          void openSettingsTab('providers');
        }}
        className="flex shrink-0 items-center gap-1 text-caption text-fg-tertiary transition-colors duration-fast hover:text-accent"
      >
        <SettingsIcon size={12} /> {t('activity.settings')}
      </button>
    </div>
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
