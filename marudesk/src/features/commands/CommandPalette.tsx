import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { Code2, Command, Compass, CornerUpLeft, FolderTree, GitBranch, Globe, MessagesSquare, RotateCcw, Search, Sparkles, SlidersHorizontal, SquareTerminal, Terminal } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useI18n } from '../../i18n/useI18n';
import type { TranslationKey } from '../../i18n/messages';
import { openInstrument, reopenTabInstrument, useInstrumentStore } from '../work-graph/instrument';
import { openSettingsTab } from '../settings/store';
import { useFlightLogStore } from '../work-graph/flight-log-store';
import { useWorkGraphStore } from '../work-graph/store';
import { useWorkspaceDeckStore } from '../workspaces/store';
import { useTourStore } from '../tour/tourStore';
import { useCommandPaletteStore } from './command-palette-store';
import { Hint, PaletteHints, PaletteOverlay } from './PaletteOverlay';
import { usePaletteListbox } from './usePaletteListbox';

/**
 * The ⌘K command palette. Runs two kinds of command: "Open…" entries summon a
 * surface as an instrument so Settings, a fresh AI Chat / CLI chat, a new editor,
 * and a blank web tab are reachable in Mission Control (where there is no tab strip
 * to open them from); "Actions" delegate to existing stores/IPC (reopen a closed
 * tab, toggle the Flight Log, return to the graph). Each open command summons the
 * surface via {@link openInstrument} / openSettingsTab; "← Graph" on the instrument
 * returns home.
 */

type CmdGroup = 'open' | 'action';

/**
 * A command's static spec. Labels/hints are {@link TranslationKey}s (not literal
 * strings) so the palette renders — and fuzzy-filters — in the active locale.
 * `gate` is an optional predicate evaluated at render so a command can hide when
 * its target doesn't exist yet (e.g. the Flight Log needs a graph).
 */
type Cmd = {
  id: string;
  labelKey: TranslationKey;
  hintKey?: TranslationKey;
  icon: ComponentType<{ size?: number }>;
  group: CmdGroup;
  /** Optional render-time predicate; the command is hidden when it returns false.
   *  Receives the reactive `hasGraph` so the palette re-filters when a flight
   *  graph appears/clears (e.g. the Flight Log toggle needs a graph). */
  gate?: (hasGraph: boolean) => boolean;
  run: () => void | Promise<void>;
};

/** A command with its translated strings resolved, ready to render and filter. */
type ResolvedCmd = {
  id: string;
  label: string;
  hint?: string;
  icon: ComponentType<{ size?: number }>;
  group: CmdGroup;
  run: () => void | Promise<void>;
};

function activeWorkspaceId(): string | undefined {
  return useWorkspaceDeckStore.getState().activeWorkspaceId ?? undefined;
}

const COMMANDS: Cmd[] = [
  {
    id: 'settings',
    labelKey: 'command.settings.label',
    hintKey: 'command.settings.hint',
    icon: SlidersHorizontal,
    group: 'open',
    run: () => openSettingsTab(),
  },
  {
    id: 'ai-chat',
    labelKey: 'command.aiChat.label',
    hintKey: 'command.aiChat.hint',
    icon: Sparkles,
    group: 'open',
    run: () => openInstrument('agent', { workspaceId: activeWorkspaceId() }),
  },
  {
    id: 'cli-chat',
    labelKey: 'command.cliChat.label',
    hintKey: 'command.cliChat.hint',
    icon: SquareTerminal,
    group: 'open',
    run: () => openInstrument('terminal', { workspaceId: activeWorkspaceId(), terminalProfile: 'agent-cli' }),
  },
  {
    id: 'terminal',
    labelKey: 'command.terminal.label',
    hintKey: 'command.terminal.hint',
    icon: Terminal,
    group: 'open',
    run: () => openInstrument('terminal', { workspaceId: activeWorkspaceId() }),
  },
  {
    id: 'editor',
    labelKey: 'command.editor.label',
    hintKey: 'command.editor.hint',
    icon: Code2,
    group: 'open',
    run: () => openInstrument('editor', { workspaceId: activeWorkspaceId() }),
  },
  {
    id: 'files',
    labelKey: 'command.files.label',
    hintKey: 'command.files.hint',
    icon: FolderTree,
    group: 'open',
    run: () => openInstrument('files', { workspaceId: activeWorkspaceId() }),
  },
  {
    id: 'search',
    labelKey: 'command.search.label',
    hintKey: 'command.search.hint',
    icon: Search,
    group: 'open',
    run: () => openInstrument('search', { workspaceId: activeWorkspaceId() }),
  },
  {
    id: 'source-control',
    labelKey: 'command.sourceControl.label',
    hintKey: 'command.sourceControl.hint',
    icon: GitBranch,
    group: 'open',
    run: () => openInstrument('sourceControl', { workspaceId: activeWorkspaceId() }),
  },
  {
    id: 'web',
    labelKey: 'command.web.label',
    hintKey: 'command.web.hint',
    icon: Globe,
    group: 'open',
    run: () => openInstrument('web'),
  },
  {
    id: 'reopen-tab',
    labelKey: 'command.reopenTab.label',
    hintKey: 'command.reopenTab.hint',
    icon: RotateCcw,
    group: 'action',
    run: () => reopenTabInstrument(),
  },
  {
    id: 'toggle-flight-log',
    labelKey: 'command.toggleFlightLog.label',
    hintKey: 'command.toggleFlightLog.hint',
    icon: MessagesSquare,
    group: 'action',
    // Match FlightLogButton: only offer the toggle once a flight (graph) exists,
    // so the two entry points never disagree about an empty Flight Log.
    gate: (hasGraph) => hasGraph,
    run: () => useFlightLogStore.getState().toggle(),
  },
  {
    id: 'take-a-tour',
    labelKey: 'command.takeATour.label',
    hintKey: 'command.takeATour.hint',
    icon: Compass,
    group: 'action',
    run: () => useTourStore.getState().start(),
  },
  {
    id: 'return-to-graph',
    labelKey: 'command.returnToGraph.label',
    hintKey: 'command.returnToGraph.hint',
    icon: CornerUpLeft,
    group: 'action',
    run: () => useInstrumentStore.getState().close(),
  },
];

const GROUP_LABEL_KEY: Record<CmdGroup, TranslationKey> = {
  open: 'command.group.open',
  action: 'command.group.action',
};

const GROUP_ORDER: readonly CmdGroup[] = ['open', 'action'];

/** Title-bar trigger for the command palette. */
export function CommandPaletteButton() {
  const open = useCommandPaletteStore((s) => s.open);
  const toggle = useCommandPaletteStore((s) => s.toggle);
  return (
    <button
      type="button"
      data-tour="command-palette"
      onClick={toggle}
      aria-label="Command palette"
      aria-pressed={open}
      title="Command palette (Ctrl/⌘ K)"
      className={cn(
        'no-drag inline-flex h-6 items-center justify-center rounded-md px-1.5',
        'text-fg-tertiary transition-colors duration-fast hover:bg-surface-3 hover:text-fg-secondary',
        'focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none',
        open && 'bg-surface-3 text-fg-secondary',
      )}
    >
      <Command size={13} />
    </button>
  );
}

export function CommandPalette() {
  const open = useCommandPaletteStore((s) => s.open);
  const hide = useCommandPaletteStore((s) => s.hide);
  if (!open) return null;
  return <CommandPaletteBody onClose={hide} />;
}

function CommandPaletteBody({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  // Subscribe so the gate (and thus the rendered list) recomputes when a flight
  // graph appears or clears.
  const graph = useWorkGraphStore((s) => s.graph);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const activeRef = useRef<HTMLButtonElement | null>(null);

  // Resolve each command's label/hint in the active locale (so both render and
  // filter are translated) and drop any command whose gate is currently closed.
  const resolved = useMemo<ResolvedCmd[]>(() => {
    const hasGraph = graph !== null;
    return COMMANDS.filter((c) => c.gate?.(hasGraph) ?? true).map((c) => ({
      id: c.id,
      label: t(c.labelKey),
      hint: c.hintKey ? t(c.hintKey) : undefined,
      icon: c.icon,
      group: c.group,
      run: c.run,
    }));
  }, [t, graph]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = q
      ? resolved.filter(
          (c) => c.label.toLowerCase().includes(q) || (c.hint?.toLowerCase().includes(q) ?? false),
        )
      : resolved;
    // Keep the flat order grouped (Open… then Actions) so the section headers below
    // never interleave; the array stays flat so the keyboard index math is unchanged.
    return GROUP_ORDER.flatMap((group) => matches.filter((c) => c.group === group));
  }, [query, resolved]);

  const run = (cmd: ResolvedCmd | undefined) => {
    if (!cmd) return;
    onClose();
    void cmd.run();
  };

  const clampedIndex = Math.min(index, Math.max(0, filtered.length - 1));
  const { inputProps, listboxProps, optionProps } = usePaletteListbox(
    clampedIndex,
    filtered.length,
  );

  // Keep the highlighted row in view as the keyboard moves the selection (DOM
  // sync only — mirrors the sibling palettes).
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [clampedIndex]);

  return (
    <PaletteOverlay ariaLabel="Command palette" onClose={onClose} className="max-w-lg">
        <div className="flex items-center gap-2 border-b border-subtle px-3 py-2.5">
          <Command size={14} className="shrink-0 text-fg-tertiary" />
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIndex((i) => Math.min(i + 1, filtered.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIndex((i) => Math.max(i - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                run(filtered[clampedIndex]);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
              }
            }}
            aria-label="Command"
            placeholder="Type a command…"
            spellCheck={false}
            {...inputProps}
            className="flex-1 bg-transparent text-body-sm text-fg-primary placeholder:text-fg-tertiary focus:outline-none"
          />
        </div>
        <ul {...listboxProps} className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {filtered.length === 0 ? (
            <li className="px-3 py-6 text-center text-caption text-fg-tertiary">{t('command.empty')}</li>
          ) : (
            filtered.map((cmd, i) => {
              const Icon = cmd.icon;
              const startsGroup = i === 0 || filtered[i - 1]?.group !== cmd.group;
              const isActive = i === clampedIndex;
              return (
                <li key={cmd.id}>
                  {startsGroup ? (
                    <div className="px-2.5 pb-1 pt-2 text-caption font-medium uppercase tracking-wide text-fg-tertiary first:pt-1">
                      {t(GROUP_LABEL_KEY[cmd.group])}
                    </div>
                  ) : null}
                  <button
                    ref={isActive ? activeRef : undefined}
                    type="button"
                    onMouseEnter={() => setIndex(i)}
                    onClick={() => run(cmd)}
                    aria-label={cmd.label}
                    {...optionProps(i)}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors duration-fast',
                      isActive ? 'bg-surface-3' : 'hover:bg-surface-2',
                    )}
                  >
                    <Icon size={15} />
                    <span className="text-body-sm text-fg-primary">{cmd.label}</span>
                    {cmd.hint ? <span className="ml-auto truncate text-caption text-fg-tertiary">{cmd.hint}</span> : null}
                  </button>
                </li>
              );
            })
          )}
        </ul>
        <PaletteHints>
          <Hint k="↑↓" label={t('palette.hint.move')} />
          <Hint k="↵" label={t('palette.hint.run')} />
          <Hint k="esc" label={t('palette.hint.close')} />
        </PaletteHints>
    </PaletteOverlay>
  );
}
