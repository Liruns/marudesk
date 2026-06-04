import { type ComponentType, type FormEvent, type ReactNode } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Code2,
  Globe,
  House,
  Lock,
  Maximize2,
  Minimize2,
  RotateCw,
  SlidersHorizontal,
  Sparkles,
  SquareTerminal,
  X,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { useI18n } from '../../i18n/useI18n';
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

export function PaneHeader({
  tab,
  focused,
  maximized,
  onToggleMaximize,
  onClose,
}: {
  tab: TabState;
  focused: boolean;
  maximized: boolean;
  onToggleMaximize: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const maximizeLabel = t(maximized ? 'tabs.pane.restore' : 'tabs.pane.maximize');
  return (
    <div
      className={cn(
        'relative h-7 shrink-0 flex items-center gap-1 pl-2 pr-1 border-b border-subtle',
        // Focused pane's header lifts a step and grows an accent top edge — the
        // same grouping cue the strip uses — so the live pane (the one the
        // omnibox + keyboard drive) is unmistakable among the tiles.
        focused ? 'bg-surface-2' : 'bg-surface-1',
      )}
    >
      {focused ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-accent/70"
        />
      ) : null}
      {tab.kind === 'web' ? (
        focused ? (
          <WebOmnibox />
        ) : (
          <WebUrlStatic tab={tab} />
        )
      ) : (
        <FeatureLabel tab={tab} focused={focused} />
      )}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggleMaximize();
        }}
        aria-label={maximizeLabel}
        title={maximizeLabel}
        aria-pressed={maximized}
        className={cn(
          'size-5 shrink-0 rounded flex items-center justify-center transition-colors duration-fast',
          maximized
            ? 'text-accent hover:bg-surface-3'
            : 'text-fg-tertiary hover:bg-surface-3 hover:text-fg-primary',
        )}
      >
        {maximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        aria-label={t('tabs.pane.close')}
        title={t('tabs.pane.close')}
        className="size-5 shrink-0 rounded flex items-center justify-center text-fg-tertiary hover:bg-surface-3 hover:text-fg-primary transition-colors duration-fast"
      >
        <X size={13} />
      </button>
    </div>
  );
}

/** Live omnibox for the focused web pane (drives the active tab via the store). */
function WebOmnibox() {
  const { t } = useI18n();
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
      <MiniBtn label={t('browser.nav.back')} disabled={!nav.canGoBack} onClick={() => void goBack()}>
        <ArrowLeft size={13} />
      </MiniBtn>
      <MiniBtn
        label={t('browser.nav.forward')}
        disabled={!nav.canGoForward}
        onClick={() => void goForward()}
      >
        <ArrowRight size={13} />
      </MiniBtn>
      <MiniBtn
        label={t(nav.isLoading ? 'browser.nav.stop' : 'browser.nav.reload')}
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
            placeholder={t('tabs.pane.addressPlaceholder')}
            value={pendingUrl}
            onChange={(e) => setPendingUrl(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            className="flex-1 min-w-0 bg-transparent text-caption text-fg-primary placeholder:text-fg-tertiary focus:outline-none"
            aria-label={t('browser.address.aria')}
          />
        </div>
      </form>
    </>
  );
}

/** Read-only URL for a blurred web pane — favicon (when known) aids recognition. */
function WebUrlStatic({ tab }: { tab: TabState }) {
  const { t } = useI18n();
  return (
    <div className="flex-1 min-w-0 flex items-center gap-1.5 pl-1">
      {tab.favicon ? (
        <img
          src={tab.favicon}
          alt=""
          aria-hidden
          draggable={false}
          className="size-3.5 shrink-0 rounded-[2px] object-contain"
        />
      ) : (
        <Scheme url={tab.url} isSecure={tab.isSecure} />
      )}
      <span className="text-caption text-fg-secondary truncate">
        {tab.title || tab.url || t('tabs.kind.web')}
      </span>
    </div>
  );
}

function FeatureLabel({ tab, focused }: { tab: TabState; focused: boolean }) {
  const { t } = useI18n();
  const Icon = KIND_ICON[tab.kind];
  const label = tab.title || t(`tabs.kind.${tab.kind}` as const);
  return (
    <div className="flex-1 min-w-0 flex items-center gap-1.5">
      {/* Focused pane tints its glyph accent — same "active surface" cue the
          strip uses for a feature tab's icon, so the live pane reads at a glance. */}
      <span className={focused ? 'text-accent shrink-0' : 'text-fg-tertiary shrink-0'}>
        <Icon size={13} />
      </span>
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
  const { t } = useI18n();
  if (isSecure) {
    return (
      <span className="text-fg-secondary shrink-0" title={t('browser.security.secure.title')}>
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
