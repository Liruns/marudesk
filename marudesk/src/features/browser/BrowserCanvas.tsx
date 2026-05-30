import { useEffect, useRef, type FormEvent } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Globe,
  Lock,
  MousePointerClick,
  RotateCw,
  Wrench,
  X,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { useWebPageStore } from './store';
import { useTabsStore } from '../tabs/store';
import { useSettingsStore } from '../settings/store';

/**
 * Full-bleed browser canvas. The tab strip is owned by the TitleBar (so it
 * sits in the drag region, Chrome-style); this component is just the toolbar
 * row and the live WebContentsView container that the host paints over.
 *
 * The container reports its bounds to the main process so the embedded view
 * tracks the React-controlled rectangle exactly.
 *
 * Address bar / inspect / captures come from the web-page store; `nav` and the
 * back/forward/reload actions belong to the active tab, so they come from the
 * tab registry store.
 */
export function BrowserCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const pendingUrl = useWebPageStore((s) => s.pendingUrl);
  const currentUrl = useWebPageStore((s) => s.currentUrl);
  const inspectMode = useWebPageStore((s) => s.inspectMode);
  const nav = useTabsStore((s) => s.nav);
  const setPendingUrl = useWebPageStore((s) => s.setPendingUrl);
  const commitNavigate = useWebPageStore((s) => s.commitNavigate);
  const toggleInspect = useWebPageStore((s) => s.toggleInspect);
  const goBack = useTabsStore((s) => s.goBack);
  const goForward = useTabsStore((s) => s.goForward);
  const reloadOrStop = useTabsStore((s) => s.reloadOrStop);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const sendBounds = () => {
      const rect = el.getBoundingClientRect();
      void window.marudesk.invoke('browser:set-bounds', {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      });
    };

    sendBounds();
    const ro = new ResizeObserver(sendBounds);
    ro.observe(el);
    window.addEventListener('resize', sendBounds);
    window.addEventListener('scroll', sendBounds, true);
    // Interface zoom changes the root font-size, which reflows this rect but
    // fires no resize/scroll event. Re-measure on any settings change (after
    // layout settles) so the embedded view never drifts from the React rect.
    const unsubSettings = useSettingsStore.subscribe(() => {
      requestAnimationFrame(sendBounds);
    });

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', sendBounds);
      window.removeEventListener('scroll', sendBounds, true);
      unsubSettings();
      // Don't zero the bounds on unmount. The host hides the inactive web view
      // on tab switch, so keeping the last bounds lets the view reappear at the
      // right rect the instant we return to a web tab — no 0-size flash.
    };
  }, []);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void commitNavigate();
  };

  const hasUrl = currentUrl.length > 0 || nav.url.length > 0;

  return (
    <div className="flex-1 min-w-0 flex flex-col bg-surface-page">
      {/* Toolbar */}
      <div className="shrink-0 px-3 py-1.5 flex items-center gap-1.5 bg-surface-1 border-b border-subtle relative">
        <NavIconButton
          label="Back"
          disabled={!nav.canGoBack}
          onClick={() => void goBack()}
        >
          <ArrowLeft size={16} />
        </NavIconButton>
        <NavIconButton
          label="Forward"
          disabled={!nav.canGoForward}
          onClick={() => void goForward()}
        >
          <ArrowRight size={16} />
        </NavIconButton>
        <NavIconButton
          label={nav.isLoading ? 'Stop' : 'Reload'}
          disabled={!hasUrl}
          onClick={() => void reloadOrStop()}
        >
          {nav.isLoading ? <X size={16} /> : <RotateCw size={16} />}
        </NavIconButton>

        <form onSubmit={onSubmit} className="flex-1 min-w-0" role="search">
          <div
            className={cn(
              'h-8 w-full rounded-pill bg-surface-page border flex items-center pl-3 pr-2 gap-2',
              'border-default focus-within:border-accent',
              'transition-colors duration-fast',
            )}
          >
            <SchemeIndicator
              url={nav.url || currentUrl}
              isSecure={nav.isSecure}
            />
            <input
              type="text"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="Search or type a URL"
              value={pendingUrl}
              onChange={(e) => setPendingUrl(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              className={cn(
                'flex-1 min-w-0 bg-transparent text-body-sm text-fg-primary',
                'placeholder:text-fg-tertiary focus:outline-none',
              )}
              aria-label="Address bar"
            />
            {nav.isLoading ? (
              <span
                aria-hidden
                className="size-2 rounded-pill bg-accent animate-pulse"
              />
            ) : null}
          </div>
        </form>

        <NavIconButton
          label={inspectMode ? 'Exit inspect mode' : 'Inspect element'}
          active={inspectMode}
          onClick={() => void toggleInspect()}
          aria-pressed={inspectMode}
        >
          <MousePointerClick size={16} />
        </NavIconButton>

        <NavIconButton
          label="Toggle DevTools (F12)"
          onClick={() => void window.marudesk.invoke('browser:toggle-devtools')}
        >
          <Wrench size={16} />
        </NavIconButton>

        {/* Loading bar pinned to the bottom edge of the toolbar */}
        {nav.isLoading ? (
          <span
            aria-hidden
            className="absolute left-0 right-0 bottom-0 h-px overflow-hidden"
          >
            <span
              className="absolute inset-y-0 left-0 w-1/3 bg-accent"
              style={{ animation: 'marudesk-loading 1.2s linear infinite' }}
            />
          </span>
        ) : null}
      </div>

      {/* Stage — full-bleed, no padding, the WebContentsView paints here */}
      <div
        ref={containerRef}
        className={cn(
          'flex-1 min-h-0 relative bg-surface-1',
          inspectMode ? 'ring-1 ring-inset ring-accent' : '',
          'transition-shadow duration-fast',
        )}
        aria-label="Browser stage"
      >
        {!hasUrl ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center px-8 pointer-events-none">
            <span className="text-caption uppercase tracking-wider text-fg-tertiary">
              Browser stage
            </span>
            <h2 className="text-title text-fg-secondary">No page loaded</h2>
            <p className="text-body-sm text-fg-tertiary max-w-md">
              Type a URL and press Enter. Toggle the cursor button to capture
              elements into the context panel.
            </p>
          </div>
        ) : null}
        {inspectMode ? (
          <div className="absolute top-2 left-2 z-10 pointer-events-none">
            <span className="inline-flex items-center gap-1.5 rounded-pill bg-accent-subtle text-accent text-caption font-medium px-2 py-0.5">
              <span className="size-1.5 rounded-pill bg-accent" />
              Inspect — click an element, Esc to exit
            </span>
          </div>
        ) : null}
      </div>
      <style>{`
        @keyframes marudesk-loading {
          0%   { transform: translateX(-100%); }
          50%  { transform: translateX(150%); }
          100% { transform: translateX(400%); }
        }
      `}</style>
    </div>
  );
}

function NavIconButton({
  label,
  disabled = false,
  active = false,
  onClick,
  children,
  ...rest
}: {
  label: string;
  disabled?: boolean;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        'size-8 rounded-pill flex items-center justify-center shrink-0 transition-colors duration-fast',
        disabled
          ? 'text-fg-tertiary opacity-40 cursor-not-allowed'
          : active
            ? 'text-accent bg-accent-subtle/40 hover:bg-accent-subtle/60'
            : 'text-fg-secondary hover:bg-surface-2 hover:text-fg-primary',
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

function SchemeIndicator({
  url,
  isSecure,
}: {
  url: string;
  isSecure: boolean;
}) {
  if (!url) {
    return (
      <span className="text-fg-tertiary shrink-0" aria-hidden>
        <Globe size={14} />
      </span>
    );
  }
  if (isSecure) {
    return (
      <span
        className="text-fg-secondary shrink-0"
        aria-label="Secure connection"
        title="Connection is encrypted (HTTPS)"
      >
        <Lock size={14} />
      </span>
    );
  }
  return (
    <span
      className="text-warning shrink-0"
      aria-label="Not secure"
      title="Connection is not encrypted"
    >
      <Globe size={14} />
    </span>
  );
}
