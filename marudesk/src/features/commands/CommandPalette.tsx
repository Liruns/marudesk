import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { Code2, Command, CornerUpLeft, FolderTree, GitBranch, Globe, MessagesSquare, RotateCcw, Search, Sparkles, SlidersHorizontal, SquareTerminal, Terminal } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useI18n } from '../../i18n/useI18n';
import { openInstrument, useInstrumentStore } from '../work-graph/instrument';
import { openSettingsTab } from '../settings/store';
import { useFlightLogStore } from '../work-graph/flight-log-store';
import { useTabsStore } from '../tabs/store';
import { useWorkspaceDeckStore } from '../workspaces/store';
import { useCommandPaletteStore } from './command-palette-store';
import { Hint, PaletteHints, PaletteOverlay } from './PaletteOverlay';

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

type Cmd = {
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
    label: 'Open Settings',
    hint: 'Providers, appearance, agent, MCP…',
    icon: SlidersHorizontal,
    group: 'open',
    run: () => openSettingsTab(),
  },
  {
    id: 'ai-chat',
    label: 'New AI Chat',
    hint: 'Full-surface agent conversation',
    icon: Sparkles,
    group: 'open',
    run: () => openInstrument('agent', { workspaceId: activeWorkspaceId() }),
  },
  {
    id: 'cli-chat',
    label: 'New CLI Chat',
    hint: 'The agent in a terminal',
    icon: SquareTerminal,
    group: 'open',
    run: () => openInstrument('terminal', { workspaceId: activeWorkspaceId(), terminalProfile: 'agent-cli' }),
  },
  {
    id: 'terminal',
    label: 'New Terminal',
    hint: 'A shell in the active workspace',
    icon: Terminal,
    group: 'open',
    run: () => openInstrument('terminal', { workspaceId: activeWorkspaceId() }),
  },
  {
    id: 'editor',
    label: 'New Editor',
    hint: 'An untitled Monaco buffer',
    icon: Code2,
    group: 'open',
    run: () => openInstrument('editor', { workspaceId: activeWorkspaceId() }),
  },
  {
    id: 'files',
    label: 'Open Files',
    hint: 'Browse the workspace file tree',
    icon: FolderTree,
    group: 'open',
    run: () => openInstrument('files', { workspaceId: activeWorkspaceId() }),
  },
  {
    id: 'search',
    label: 'Search in Files',
    hint: 'Find text across the workspace',
    icon: Search,
    group: 'open',
    run: () => openInstrument('search', { workspaceId: activeWorkspaceId() }),
  },
  {
    id: 'source-control',
    label: 'Source Control',
    hint: 'Git status, diffs, and commits',
    icon: GitBranch,
    group: 'open',
    run: () => openInstrument('sourceControl', { workspaceId: activeWorkspaceId() }),
  },
  {
    id: 'web',
    label: 'New Web Tab',
    hint: 'A runtime-aware browser',
    icon: Globe,
    group: 'open',
    run: () => openInstrument('web'),
  },
  {
    id: 'reopen-tab',
    label: 'Reopen Closed Tab',
    hint: 'Restore the last closed tab',
    icon: RotateCcw,
    group: 'action',
    run: () => useTabsStore.getState().reopenClosedTab(),
  },
  {
    id: 'toggle-flight-log',
    label: 'Toggle Flight Log',
    hint: "Every task's conversation in one place",
    icon: MessagesSquare,
    group: 'action',
    run: () => useFlightLogStore.getState().toggle(),
  },
  {
    id: 'return-to-graph',
    label: 'Return to Graph',
    hint: 'Close the instrument and go home',
    icon: CornerUpLeft,
    group: 'action',
    run: () => useInstrumentStore.getState().close(),
  },
];

const GROUP_LABEL: Record<CmdGroup, string> = {
  open: 'Open',
  action: 'Actions',
};

const GROUP_ORDER: readonly CmdGroup[] = ['open', 'action'];

/** Title-bar trigger for the command palette. */
export function CommandPaletteButton() {
  const open = useCommandPaletteStore((s) => s.open);
  const toggle = useCommandPaletteStore((s) => s.toggle);
  return (
    <button
      type="button"
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
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const activeRef = useRef<HTMLButtonElement | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = q
      ? COMMANDS.filter(
          (c) => c.label.toLowerCase().includes(q) || (c.hint?.toLowerCase().includes(q) ?? false),
        )
      : COMMANDS;
    // Keep the flat order grouped (Open… then Actions) so the section headers below
    // never interleave; the array stays flat so the keyboard index math is unchanged.
    return GROUP_ORDER.flatMap((group) => matches.filter((c) => c.group === group));
  }, [query]);

  const run = (cmd: Cmd | undefined) => {
    if (!cmd) return;
    onClose();
    void cmd.run();
  };

  const clampedIndex = Math.min(index, Math.max(0, filtered.length - 1));

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
            className="flex-1 bg-transparent text-body-sm text-fg-primary placeholder:text-fg-tertiary focus:outline-none"
          />
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {filtered.length === 0 ? (
            <li className="px-3 py-6 text-center text-caption text-fg-tertiary">No matching command.</li>
          ) : (
            filtered.map((cmd, i) => {
              const Icon = cmd.icon;
              const startsGroup = i === 0 || filtered[i - 1]?.group !== cmd.group;
              const isActive = i === clampedIndex;
              return (
                <li key={cmd.id}>
                  {startsGroup ? (
                    <div className="px-2.5 pb-1 pt-2 text-caption font-medium uppercase tracking-wide text-fg-tertiary first:pt-1">
                      {GROUP_LABEL[cmd.group]}
                    </div>
                  ) : null}
                  <button
                    ref={isActive ? activeRef : undefined}
                    type="button"
                    onMouseEnter={() => setIndex(i)}
                    onClick={() => run(cmd)}
                    aria-label={cmd.label}
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
          {/* No palette.hint.run key exists yet and i18n is owned elsewhere this
              round; the dialog label is already a literal, so this verb is too. */}
          <Hint k="↵" label="run" />
          <Hint k="esc" label={t('palette.hint.close')} />
        </PaletteHints>
    </PaletteOverlay>
  );
}
