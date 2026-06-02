import { useState, type MouseEvent, type ReactNode } from 'react';
import {
  Files,
  GitBranch,
  KeyRound,
  MessageSquareText,
  Palette,
  Search,
  Settings as SettingsIcon,
  SlidersHorizontal,
} from 'lucide-react';
import { cn } from '../lib/cn';
import { useWebPageStore } from '../features/browser/store';
import { useAgentStore } from '../features/agent/store';
import { openSettingsTab } from '../features/settings/store';
import { ContextMenu } from './ContextMenu';
import { AppearancePopover } from '../features/theme/AppearancePopover';

type Props = {
  explorerOpen: boolean;
  onToggleExplorer: () => void;
  searchOpen: boolean;
  onToggleSearch: () => void;
  sourceControlOpen: boolean;
  onToggleSourceControl: () => void;
  drawerOpen: boolean;
  onToggleDrawer: () => void;
};

/**
 * VSCode/Cursor-style activity bar: a thin vertical rail anchored to the left
 * edge of the work region. It's a view switcher — each button toggles a side
 * panel (Explorer, Context). The foot gear opens a menu (Settings tab, API
 * Providers) rather than a single action, so new app-level entries can slot in
 * without crowding the rail.
 *
 * Width is 48px to match VSCode; icons are 18px so they read at this scale.
 */
export function ActivityBar({
  explorerOpen,
  onToggleExplorer,
  searchOpen,
  onToggleSearch,
  sourceControlOpen,
  onToggleSourceControl,
  drawerOpen,
  onToggleDrawer,
}: Props) {
  const captureCount = useWebPageStore((s) => s.captures.length);
  // The agent parks on approvals/questions in the drawer; surface that as a
  // persistent attention dot on the rail so it's visible from any tab.
  const agentWaiting = useAgentStore((s) => s.chat.status === 'waiting_for_user');
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [appearanceOpen, setAppearanceOpen] = useState(false);

  return (
    <nav
      aria-label="Activity bar"
      className="w-12 shrink-0 flex flex-col items-center py-2 gap-1 bg-surface-1 border-r border-subtle"
    >
      <ActivityButton
        label={explorerOpen ? 'Hide Explorer' : 'Show Explorer'}
        active={explorerOpen}
        onClick={onToggleExplorer}
      >
        <Files size={18} />
      </ActivityButton>
      <ActivityButton
        label={searchOpen ? 'Hide Search' : 'Search'}
        active={searchOpen}
        onClick={onToggleSearch}
      >
        <Search size={18} />
      </ActivityButton>
      <ActivityButton
        label={sourceControlOpen ? 'Hide Source Control' : 'Source Control'}
        active={sourceControlOpen}
        onClick={onToggleSourceControl}
      >
        <GitBranch size={18} />
      </ActivityButton>
      <ActivityButton
        label={
          agentWaiting
            ? 'Agent needs your input'
            : drawerOpen
              ? 'Hide context panel'
              : 'Show context panel'
        }
        onClick={onToggleDrawer}
        active={drawerOpen}
        badge={captureCount}
        attention={agentWaiting}
      >
        <MessageSquareText size={18} />
      </ActivityButton>
      <span className="flex-1" aria-hidden />
      <ActivityButton
        label="Settings"
        active={!!menu}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({ x: r.right + 6, y: r.top });
        }}
      >
        <SettingsIcon size={18} />
      </ActivityButton>
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: 'Appearance…',
              icon: <Palette size={15} />,
              onSelect: () => setAppearanceOpen(true),
            },
            { type: 'separator' },
            {
              label: 'Settings',
              icon: <SlidersHorizontal size={15} />,
              onSelect: () => void openSettingsTab(),
            },
            { type: 'separator' },
            {
              label: 'API Providers…',
              icon: <KeyRound size={15} />,
              onSelect: () => void openSettingsTab('providers'),
            },
          ]}
        />
      ) : null}
      {appearanceOpen ? (
        <AppearancePopover onClose={() => setAppearanceOpen(false)} />
      ) : null}
    </nav>
  );
}

function ActivityButton({
  label,
  onClick,
  disabled = false,
  active = false,
  badge,
  attention = false,
  children,
}: {
  label: string;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  active?: boolean;
  badge?: number;
  attention?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={cn(
        'relative size-9 rounded-md flex items-center justify-center shrink-0',
        'transition-colors duration-fast',
        active
          ? 'text-accent bg-accent-subtle/30'
          : 'text-fg-tertiary hover:text-fg-primary hover:bg-surface-2',
        disabled ? 'opacity-40 cursor-not-allowed' : '',
      )}
    >
      {children}
      {active ? (
        <span
          aria-hidden
          className="absolute left-[-6px] top-1.5 bottom-1.5 w-0.5 rounded-r-full bg-accent"
        />
      ) : null}
      {attention ? (
        <span
          aria-hidden
          className="absolute -top-0.5 -right-0.5 size-2.5 rounded-pill bg-warning ring-2 ring-surface-1 animate-pulse"
        />
      ) : typeof badge === 'number' && badge > 0 ? (
        <span
          aria-hidden
          className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-pill bg-accent text-[10px] font-medium text-white flex items-center justify-center tabular-nums"
        >
          {badge > 99 ? '99+' : badge}
        </span>
      ) : null}
    </button>
  );
}
