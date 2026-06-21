import { useMemo, useState, type ComponentType } from 'react';
import { Code2, Command, Globe, Sparkles, SlidersHorizontal, SquareTerminal, Terminal } from 'lucide-react';
import { cn } from '../../lib/cn';
import { openInstrument } from '../work-graph/instrument';
import { openSettingsTab } from '../settings/store';
import { useWorkspaceDeckStore } from '../workspaces/store';
import { useCommandPaletteStore } from './command-palette-store';

/**
 * The ⌘K command palette. Runs the "open a surface as an instrument" commands so
 * Settings, a fresh AI Chat / CLI chat, a new editor, and a blank web tab are
 * reachable in Mission Control (where there is no tab strip to open them from).
 * Each command summons the surface via {@link openInstrument} / openSettingsTab;
 * "← Graph" on the instrument returns home.
 */

type Cmd = {
  id: string;
  label: string;
  hint?: string;
  icon: ComponentType<{ size?: number }>;
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
    run: () => openSettingsTab(),
  },
  {
    id: 'ai-chat',
    label: 'New AI Chat',
    hint: 'Full-surface agent conversation',
    icon: Sparkles,
    run: () => openInstrument('agent', { workspaceId: activeWorkspaceId() }),
  },
  {
    id: 'cli-chat',
    label: 'New CLI Chat',
    hint: 'The agent in a terminal',
    icon: SquareTerminal,
    run: () => openInstrument('terminal', { workspaceId: activeWorkspaceId(), terminalProfile: 'agent-cli' }),
  },
  {
    id: 'terminal',
    label: 'New Terminal',
    hint: 'A shell in the active workspace',
    icon: Terminal,
    run: () => openInstrument('terminal', { workspaceId: activeWorkspaceId() }),
  },
  {
    id: 'editor',
    label: 'New Editor',
    hint: 'An untitled Monaco buffer',
    icon: Code2,
    run: () => openInstrument('editor', { workspaceId: activeWorkspaceId() }),
  },
  {
    id: 'web',
    label: 'New Web Tab',
    hint: 'A runtime-aware browser',
    icon: Globe,
    run: () => openInstrument('web'),
  },
];

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
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return COMMANDS;
    return COMMANDS.filter(
      (c) => c.label.toLowerCase().includes(q) || (c.hint?.toLowerCase().includes(q) ?? false),
    );
  }, [query]);

  const run = (cmd: Cmd | undefined) => {
    if (!cmd) return;
    onClose();
    void cmd.run();
  };

  const clampedIndex = Math.min(index, Math.max(0, filtered.length - 1));

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <button type="button" aria-label="Close command palette" className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative z-10 mt-16 flex w-full max-w-lg flex-col overflow-hidden rounded-lg chrome-panel shadow-lifted motion-safe:animate-scale-in">
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
        <ul className="max-h-[min(60vh,360px)] overflow-y-auto p-1.5">
          {filtered.length === 0 ? (
            <li className="px-3 py-6 text-center text-caption text-fg-tertiary">No matching command.</li>
          ) : (
            filtered.map((cmd, i) => {
              const Icon = cmd.icon;
              return (
                <li key={cmd.id}>
                  <button
                    type="button"
                    onMouseEnter={() => setIndex(i)}
                    onClick={() => run(cmd)}
                    aria-label={cmd.label}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors duration-fast',
                      i === clampedIndex ? 'bg-surface-3' : 'hover:bg-surface-2',
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
      </div>
    </div>
  );
}
