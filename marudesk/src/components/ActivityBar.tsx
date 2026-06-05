import { useState, type MouseEvent, type ReactNode } from 'react';
import {
  Bot,
  Files,
  GitBranch,
  KeyRound,
  MessageSquareText,
  Palette,
  Plug,
  Radio,
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
import { useI18n } from '../i18n/useI18n';

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

/** Platform-aware label for the "open Settings" accelerator (Ctrl/Cmd+,). */
function settingsShortcut(): string {
  const isMac =
    typeof navigator !== 'undefined' && navigator.userAgent.includes('Macintosh');
  return isMac ? '⌘,' : 'Ctrl+,';
}

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
  const { t } = useI18n();

  return (
    <nav
      aria-label={t('activity.barLabel')}
      className="chrome-rail w-12 shrink-0 flex flex-col items-center py-2 gap-1 border-r"
    >
      <ActivityButton
        label={
          explorerOpen ? t('activity.hideExplorer') : t('activity.showExplorer')
        }
        active={explorerOpen}
        onClick={onToggleExplorer}
      >
        <Files size={18} />
      </ActivityButton>
      <ActivityButton
        label={searchOpen ? t('activity.hideSearch') : t('activity.search')}
        active={searchOpen}
        onClick={onToggleSearch}
      >
        <Search size={18} />
      </ActivityButton>
      <ActivityButton
        label={
          sourceControlOpen
            ? t('activity.hideSourceControl')
            : t('activity.sourceControl')
        }
        active={sourceControlOpen}
        onClick={onToggleSourceControl}
      >
        <GitBranch size={18} />
      </ActivityButton>
      <ActivityButton
        label={
          agentWaiting
            ? t('activity.needsInput')
            : drawerOpen
              ? t('activity.hideContext')
              : t('activity.showContext')
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
        label={t('activity.settings')}
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
              label: t('activity.appearance'),
              icon: <Palette size={15} />,
              onSelect: () => setAppearanceOpen(true),
            },
            { type: 'separator' },
            {
              label: t('activity.settings'),
              icon: <SlidersHorizontal size={15} />,
              shortcut: settingsShortcut(),
              onSelect: () => void openSettingsTab(),
            },
            { type: 'separator' },
            {
              label: t('settings.category.agent.label'),
              icon: <Bot size={15} />,
              onSelect: () => void openSettingsTab('agent'),
            },
            {
              label: t('settings.category.providers.label'),
              icon: <KeyRound size={15} />,
              onSelect: () => void openSettingsTab('providers'),
            },
            {
              label: t('settings.category.mcp.label'),
              icon: <Plug size={15} />,
              onSelect: () => void openSettingsTab('mcp'),
            },
            {
              label: t('settings.category.remote.label'),
              icon: <Radio size={15} />,
              onSelect: () => void openSettingsTab('remote'),
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
        'chrome-icon-button relative size-9 shrink-0',
        active
          ? 'text-accent bg-accent-subtle/40 shadow-highlight hover:bg-accent-subtle/40 hover:text-accent'
          : 'text-fg-tertiary',
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
