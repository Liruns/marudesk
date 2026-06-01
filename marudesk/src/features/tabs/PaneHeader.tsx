import { type ComponentType, type FormEvent, type ReactNode } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Code2,
  Globe,
  House,
  Lock,
  RotateCw,
  SlidersHorizontal,
  Sparkles,
  SquareTerminal,
  X,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { useWebPageStore } from '../browser/store';
import { useTabsStore } from './store';
import type { TabKind, TabState } from '../../../shared/browser';

/**
 * Per-pane chrome for the split grid. In single-tab mode the BrowserCanvas toolbar
 * gives a web tab its address bar; in the grid that toolbar is gone, so each pane
 * grows a slim header sized to its kind:
 *   - web + focused  → a live, compact omnibox driving the active tab (the
 *                      focused pane IS the active tab) + back/forward/reload;
 *   - web + blurred  → the tab's URL read-only (click the pane to focus it);
 *   - feature        → a kind icon + the tab title.
 * The pane-close control lives here too, so it never floats over content.
 */

const KIND_ICON: Record<TabKind, ComponentType<{ size?: number }>> = {
  web: Globe,
  terminal: SquareTerminal,
  editor: Code2,
  home: House,
  settings: SlidersHorizontal,
  agent: Sparkles,
};

const KIND_LABEL: Record<Exclude<TabKind, 'web'>, string> = {
  terminal: 'Terminal',
  editor: 'Editor',
  home: 'New Tab',
  settings: 'Settings',
  agent: 'AI Chat',
};

export function PaneHeader({
  tab,
  focused,
  onClose,
}: {
  tab: TabState;
  focused: boolean;
  onClose: () => void;
}) {
  return (
    <div className="h-7 shrink-0 flex items-center gap-1 pl-2 pr-1 border-b border-subtle bg-surface-1">
      {tab.kind === 'web' ? (
        focused ? (
          <WebOmnibox />
        ) : (
          <WebUrlStatic tab={tab} />
        )
      ) : (
        <FeatureLabel tab={tab} />
      )}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        aria-label="Close pane"
        title="Close pane"
        className="size-5 shrink-0 rounded flex items-center justify-center text-fg-tertiary hover:bg-surface-2 hover:text-fg-primary transition-colors duration-fast"
      >
        <X size={13} />
      </button>
    </div>
  );
}

/** Live omnibox for the focused web pane (drives the active tab via the store). */
function WebOmnibox() {
  const pendingUrl = useWebPageStore((s) => s.pendingUrl);
  const nav = useTabsStore((s) => s.nav);
  const setPendingUrl = useWebPageStore((s) => s.setPendingUrl);
  const commitNavigate = useWebPageStore((s) => s.commitNavigate);
  const goBack = useTabsStore((s) => s.goBack);
  const goForward = useTabsStore((s) => s.goForward);
  const reloadOrStop = useTabsStore((s) => s.reloadOrStop);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void commitNavigate();
  };

  return (
    <>
      <MiniBtn label="Back" disabled={!nav.canGoBack} onClick={() => void goBack()}>
        <ArrowLeft size={13} />
      </MiniBtn>
      <MiniBtn
        label="Forward"
        disabled={!nav.canGoForward}
        onClick={() => void goForward()}
      >
        <ArrowRight size={13} />
      </MiniBtn>
      <MiniBtn
        label={nav.isLoading ? 'Stop' : 'Reload'}
        onClick={() => void reloadOrStop()}
      >
        {nav.isLoading ? <X size={13} /> : <RotateCw size={13} />}
      </MiniBtn>
      <form onSubmit={onSubmit} className="flex-1 min-w-0" role="search">
        <div className="h-5 w-full rounded bg-surface-page border border-default focus-within:border-accent transition-colors duration-fast flex items-center px-1.5 gap-1.5">
          <Scheme url={nav.url} isSecure={nav.isSecure} />
          <input
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="Search or URL"
            value={pendingUrl}
            onChange={(e) => setPendingUrl(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            className="flex-1 min-w-0 bg-transparent text-caption text-fg-primary placeholder:text-fg-tertiary focus:outline-none"
            aria-label="Address bar"
          />
        </div>
      </form>
    </>
  );
}

/** Read-only URL for a blurred web pane. */
function WebUrlStatic({ tab }: { tab: TabState }) {
  return (
    <div className="flex-1 min-w-0 flex items-center gap-1.5">
      <Scheme url={tab.url} isSecure={tab.isSecure} />
      <span className="text-caption text-fg-tertiary truncate">
        {tab.url || tab.title || 'New tab'}
      </span>
    </div>
  );
}

function FeatureLabel({ tab }: { tab: TabState }) {
  const Icon = KIND_ICON[tab.kind];
  const label =
    tab.title || KIND_LABEL[tab.kind as Exclude<TabKind, 'web'>] || 'Tab';
  return (
    <div className="flex-1 min-w-0 flex items-center gap-1.5 text-fg-tertiary">
      <Icon size={13} />
      <span className="text-caption text-fg-secondary truncate">{label}</span>
    </div>
  );
}

function MiniBtn({
  label,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        'size-5 shrink-0 rounded flex items-center justify-center transition-colors duration-fast',
        disabled
          ? 'text-fg-tertiary opacity-40 cursor-not-allowed'
          : 'text-fg-secondary hover:bg-surface-2 hover:text-fg-primary',
      )}
    >
      {children}
    </button>
  );
}

function Scheme({ url, isSecure }: { url: string; isSecure: boolean }) {
  if (isSecure) {
    return (
      <span className="text-fg-secondary shrink-0" title="Secure (HTTPS)">
        <Lock size={11} />
      </span>
    );
  }
  return (
    <span
      className={url ? 'text-warning shrink-0' : 'text-fg-tertiary shrink-0'}
      aria-hidden
    >
      <Globe size={11} />
    </span>
  );
}
