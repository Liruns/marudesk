import { useEffect, useRef } from 'react';
import { FileCode, X } from 'lucide-react';
import { cn } from '../../../lib/cn';
import { useI18n } from '../../../i18n/useI18n';
import type { TranslationKey } from '../../../i18n/messages';
import { findModel, providerLabel } from '../../../../shared/providers';
import { estimateCostUsd, formatCostUsd } from '../../../../shared/model-pricing';
import { SLASH_COMMANDS, type SlashCommand } from '../../../../shared/slash-commands';
import { useSettingsStore } from '../../settings/store';
import { useProvidersStore } from '../../providers/store';
import { useAgentStore } from '../store';
import { formatContext, formatContextWindow } from './format';

/**
 * Keep the keyboard-highlighted row visible: the menus scroll (max-h-64) but
 * arrow keys move only the `aria-selected` row, so the list must follow it.
 */
function useScrollActiveIntoView(activeIndex: number) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = listRef.current?.querySelector('[aria-selected="true"]');
    // jsdom (tests) has no scrollIntoView; real DOM always does.
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex]);
  return listRef;
}

/** The `@file` picker — mirrors {@link SlashMenu}, listing matched workspace files. */
export function MentionMenu({
  items,
  activeIndex,
  onPick,
  onHover,
}: {
  items: string[];
  activeIndex: number;
  onPick: (path: string) => void;
  onHover: (index: number) => void;
}) {
  const { t } = useI18n();
  const listRef = useScrollActiveIntoView(activeIndex);
  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label={t('agent.chat.workspaceFiles')}
      className="absolute bottom-full left-0 right-0 mb-2 z-20 max-w-[calc(100%-16px)] @[20rem]:max-w-[13rem] max-h-64 overflow-y-auto rounded border border-default bg-surface-2 shadow-lifted py-1"
    >
      {items.map((path, i) => {
        const base = path.slice(path.lastIndexOf('/') + 1);
        const dir = path.slice(0, path.length - base.length);
        return (
          <button
            key={path}
            type="button"
            role="option"
            aria-selected={i === activeIndex}
            onMouseEnter={() => onHover(i)}
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(path);
            }}
            className={cn(
              'w-full flex items-baseline gap-2 px-3 py-1.5 text-left transition-colors duration-fast',
              i === activeIndex ? 'bg-surface-3' : 'hover:bg-surface-3/60',
            )}
          >
            <FileCode size={12} className="shrink-0 self-center text-fg-tertiary" />
            <span className="font-mono text-body-sm text-fg-primary shrink-0">{base}</span>
            {dir ? <span className="font-mono text-caption text-fg-tertiary truncate">{dir}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/* ── slash command menu ─────────────────────────────────────────────────── */

/**
 * The `/` command menu (claude-code `/init` `/review`, codex `/diff` parity).
 * Floats above the composer while the draft is a bare `/token`. Arrow keys move
 * the selection, Enter/Tab pick, Escape dismisses — all driven from the
 * composer's onKeyDown so focus stays in the textarea.
 */
const SLASH_DESCRIPTION_KEYS: Record<string, TranslationKey> = {
  init: 'agent.chat.slash.init',
  review: 'agent.chat.slash.review',
  test: 'agent.chat.slash.test',
  explain: 'agent.chat.slash.explain',
  commit: 'agent.chat.slash.commit',
  diff: 'agent.chat.slash.diff',
  context: 'agent.chat.slash.context',
  copy: 'agent.chat.slash.copy',
  compact: 'agent.chat.slash.compact',
  model: 'agent.chat.slash.model',
  new: 'agent.chat.slash.new',
  help: 'agent.chat.slash.help',
};

const SLASH_ARG_HINT_KEYS: Record<string, TranslationKey> = {
  review: 'agent.chat.slash.arg.optionalFocus',
  test: 'agent.chat.slash.arg.optionalPath',
  explain: 'agent.chat.slash.arg.fileOrSymbol',
  commit: 'agent.chat.slash.arg.optionalIntent',
  compact: 'agent.chat.slash.arg.compactFocus',
};

function slashDescription(name: string, t: (key: TranslationKey) => string): string {
  const key = SLASH_DESCRIPTION_KEYS[name];
  return key ? t(key) : name;
}

function slashArgHint(name: string, t: (key: TranslationKey) => string): string {
  const key = SLASH_ARG_HINT_KEYS[name];
  return key ? t(key) : '';
}

export function SlashMenu({
  items,
  activeIndex,
  onPick,
  onHover,
}: {
  items: SlashCommand[];
  activeIndex: number;
  onPick: (cmd: SlashCommand) => void;
  onHover: (index: number) => void;
}) {
  const { t } = useI18n();
  const listRef = useScrollActiveIntoView(activeIndex);
  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label={t('agent.chat.slashCommands')}
      className="absolute bottom-full left-0 right-0 mb-2 z-20 max-w-[calc(100%-16px)] @[20rem]:max-w-[13rem] max-h-64 overflow-y-auto rounded border border-default bg-surface-2 shadow-lifted py-1"
    >
      {items.map((cmd, i) => (
        <button
          key={cmd.name}
          type="button"
          role="option"
          aria-selected={i === activeIndex}
          onMouseEnter={() => onHover(i)}
          // Pick on mousedown so the textarea doesn't lose focus first (which
          // would tear down the menu before the click lands).
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(cmd);
          }}
          className={cn(
            'w-full flex items-baseline gap-2.5 px-3 py-1.5 text-left transition-colors duration-fast',
            i === activeIndex ? 'bg-surface-3' : 'hover:bg-surface-3/60',
          )}
        >
          {/* Left-clustered like MentionMenu: name → hint → description read as
              one phrase instead of a justified row whose description drifts to
              the far edge of a wide (full-surface) composer. */}
          <span className="font-mono text-body-sm text-fg-primary shrink-0">/{cmd.name}</span>
          {cmd.argHint ? (
            <span className="font-mono text-caption text-fg-tertiary/70 shrink-0">
              {slashArgHint(cmd.name, t)}
            </span>
          ) : null}
          <span className="text-caption text-fg-tertiary truncate">
            {slashDescription(cmd.name, t)}
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * The local readout shown by `/help` (the command list) and `/context` (what is
 * currently in the model's context window). Neither makes a model call.
 */
export function SlashInfoCard({ kind, onClose }: { kind: 'help' | 'context'; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <div className="rounded border border-subtle bg-surface-1 px-3 py-2.5">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-caption font-medium text-fg-secondary">
          {kind === 'help' ? t('agent.chat.slashCommands') : t('agent.chat.contextWindow')}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('agent.chat.dismiss')}
          className="text-fg-tertiary hover:text-fg-secondary transition-colors duration-fast"
        >
          <X size={13} />
        </button>
      </div>
      {kind === 'help' ? <SlashHelpBody /> : <SlashContextBody />}
    </div>
  );
}

function SlashHelpBody() {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-1">
      {SLASH_COMMANDS.map((cmd) => (
        <div key={cmd.name} className="flex items-baseline gap-2.5 text-body-sm">
          <span className="font-mono text-fg-primary shrink-0 w-20">/{cmd.name}</span>
          <span className="text-caption text-fg-tertiary">{slashDescription(cmd.name, t)}</span>
        </div>
      ))}
    </div>
  );
}

function SlashContextBody() {
  const { locale, t } = useI18n();
  const messages = useAgentStore((s) => s.chat.messages);
  const usage = useAgentStore((s) => s.chat.usage);
  const edits = useAgentStore((s) => s.chat.edits);
  const selectedModelKey = useProvidersStore((s) => s.selectedModelKey);
  const selectedProvider = useProvidersStore((s) => s.selectedProvider);
  const models = useProvidersStore((s) => s.models);
  const approvalMode = useSettingsStore((s) => s.settings.agent.approvalMode);
  const model = findModel(models, selectedModelKey);
  const ctx = model?.contextWindow;
  const pct = ctx ? Math.min(100, Math.round((usage.inputTokens / ctx) * 100)) : null;
  // Estimated spend for the conversation (null for local/unknown models → hidden).
  const cost = model
    ? estimateCostUsd(model.id, usage.inputTokens, usage.outputTokens)
    : null;
  const rows: Array<[string, string]> = [
    [t('agent.chat.context.provider'), providerLabel(selectedProvider)],
    [t('agent.chat.context.model'), model ? model.label : '-'],
    [t('agent.chat.context.approvalMode'), approvalMode],
    [t('agent.chat.context.messages'), String(messages.length)],
    [t('agent.chat.context.inputTokens'), usage.inputTokens.toLocaleString()],
    [t('agent.chat.context.outputTokens'), usage.outputTokens.toLocaleString()],
    ...(cost !== null
      ? ([[t('agent.chat.context.estimatedCost'), `≈ ${formatCostUsd(cost)}`]] as Array<
          [string, string]
        >)
      : []),
    [
      t('agent.chat.context.contextWindow'),
      ctx && pct !== null ? formatContextWindow(locale, formatContext(ctx), pct) : t('agent.chat.unknown'),
    ],
    [t('agent.chat.context.filesEdited'), String(edits.length)],
  ];
  return (
    <div className="flex flex-col gap-1">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-baseline justify-between gap-3 text-body-sm">
          <span className="text-caption text-fg-tertiary">{label}</span>
          <span className="font-mono text-fg-primary tabular-nums">{value}</span>
        </div>
      ))}
    </div>
  );
}
