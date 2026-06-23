import type { ComponentType } from 'react';
import {
  Code2,
  FolderTree,
  GitBranch,
  Globe,
  Search,
  SlidersHorizontal,
  Sparkles,
  Terminal,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { useI18n } from '../../i18n/useI18n';
import type { TranslationKey } from '../../i18n/messages';
import type { TabKind } from '../../../shared/browser';
import { useWorkspaceDeckStore } from '../workspaces/store';
import { openInstrument, useInstrumentStore } from './instrument';
import { openSettingsTab } from '../settings/store';

/**
 * The always-visible instrument rail down the left of Mission Control. The
 * redesign retired the legacy ActivityBar (src/features/canvas/surface.ts) and
 * routed every tool through ⌘K + task-summoning, which buried the core surfaces
 * a developer reaches for constantly — browser, editor, terminal, Source
 * Control, files, search, chat. This rail brings those entry points back as a
 * persistent, labeled launcher WITHOUT undoing the redesign: each button summons
 * the same full-area instrument the ⌘K palette opens (`openInstrument`), so the
 * graph is still the home and tools are still transient. ⌘K stays the universal
 * search/verb surface; the rail is the discoverable front door for the staples.
 */
type RailItem = {
  id: string;
  /** The instrument kind this opens — also drives the active highlight. */
  kind: TabKind;
  labelKey: TranslationKey;
  icon: ComponentType<{ size?: number }>;
  run: () => void | Promise<void>;
};

function activeWorkspaceId(): string | undefined {
  return useWorkspaceDeckStore.getState().activeWorkspaceId ?? undefined;
}

/** The staple tools, in reach-for-it order. Web doubles as the live preview. */
const TOOLS: readonly RailItem[] = [
  {
    id: 'agent',
    kind: 'agent',
    labelKey: 'rail.chat',
    icon: Sparkles,
    run: () => openInstrument('agent', { workspaceId: activeWorkspaceId() }),
  },
  { id: 'web', kind: 'web', labelKey: 'rail.web', icon: Globe, run: () => openInstrument('web') },
  {
    id: 'editor',
    kind: 'editor',
    labelKey: 'rail.editor',
    icon: Code2,
    run: () => openInstrument('editor', { workspaceId: activeWorkspaceId() }),
  },
  {
    id: 'terminal',
    kind: 'terminal',
    labelKey: 'rail.terminal',
    icon: Terminal,
    run: () => openInstrument('terminal', { workspaceId: activeWorkspaceId() }),
  },
  {
    id: 'sourceControl',
    kind: 'sourceControl',
    labelKey: 'rail.git',
    icon: GitBranch,
    run: () => openInstrument('sourceControl', { workspaceId: activeWorkspaceId() }),
  },
  {
    id: 'files',
    kind: 'files',
    labelKey: 'rail.files',
    icon: FolderTree,
    run: () => openInstrument('files', { workspaceId: activeWorkspaceId() }),
  },
  {
    id: 'search',
    kind: 'search',
    labelKey: 'rail.search',
    icon: Search,
    run: () => openInstrument('search', { workspaceId: activeWorkspaceId() }),
  },
];

/** Pinned to the bottom — config, not a per-session tool. */
const SETTINGS: RailItem = {
  id: 'settings',
  kind: 'settings',
  labelKey: 'rail.settings',
  icon: SlidersHorizontal,
  run: () => openSettingsTab(),
};

function RailButton({ item, active }: { item: RailItem; active: boolean }) {
  const { t } = useI18n();
  const label = t(item.labelKey);
  const Icon = item.icon;
  return (
    <button
      type="button"
      onClick={() => void item.run()}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={cn(
        'no-drag group relative flex flex-col items-center gap-1 rounded-lg py-2',
        'text-fg-tertiary transition-colors duration-fast active:scale-[0.99]',
        'hover:bg-surface-3 hover:text-fg-secondary',
        'focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none',
        // Active = a defined Arc "lifted pill": accent wash + a hairline accent ring.
        active &&
          'bg-accent-subtle text-accent shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_24%,transparent)] hover:bg-accent-subtle hover:text-accent',
      )}
    >
      {/* Active accent bar on the leading edge — a calm "you are here". */}
      <span
        aria-hidden
        className={cn(
          'absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-accent transition-opacity duration-fast',
          active ? 'opacity-100' : 'opacity-0',
        )}
      />
      <Icon size={18} />
      <span className="text-micro font-medium leading-none">{label}</span>
    </button>
  );
}

export function InstrumentRail() {
  const { t } = useI18n();
  // The open instrument drives the active highlight; a split's second pane counts
  // too (e.g. editor | Web both light up).
  const kind = useInstrumentStore((s) => s.kind);
  const secondaryKind = useInstrumentStore((s) => s.secondaryKind);
  const isActive = (k: TabKind): boolean => kind === k || secondaryKind === k;
  return (
    <nav
      aria-label={t('rail.label')}
      className="no-drag chrome-rail flex w-[60px] shrink-0 flex-col gap-1 border-r px-1.5 py-2 animate-fade-rise"
    >
      {TOOLS.map((item) => (
        <RailButton key={item.id} item={item} active={isActive(item.kind)} />
      ))}
      <div className="mt-auto pt-1">
        <RailButton item={SETTINGS} active={isActive(SETTINGS.kind)} />
      </div>
    </nav>
  );
}
