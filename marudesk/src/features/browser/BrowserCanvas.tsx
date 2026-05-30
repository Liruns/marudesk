import {
  useEffect,
  useLayoutEffect,
  useRef,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Download,
  Globe,
  Lock,
  MousePointerClick,
  RotateCw,
  TriangleAlert,
  Wrench,
  X,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { Button } from '../../components/ui/Button';
import { useWebPageStore } from './store';
import { useDownloadsStore } from './downloads';
import { DownloadShelf } from './DownloadShelf';
import { useTabsStore } from '../tabs/store';
import { useSettingsStore } from '../settings/store';
import { useDevtoolsStore } from '../devtools/store';
import { DevtoolsDock } from '../devtools/DevtoolsDock';
import type { HistoryEntry } from '../../../shared/history';

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
  const addressInputRef = useRef<HTMLInputElement>(null);
  // When an inline history completion lands, this holds the caret index to
  // select from (the typed prefix length); a layout effect applies it.
  const autocompleteFromRef = useRef<number | null>(null);
  const pendingUrl = useWebPageStore((s) => s.pendingUrl);
  const currentUrl = useWebPageStore((s) => s.currentUrl);
  const inspectMode = useWebPageStore((s) => s.inspectMode);
  const addressBarFocusNonce = useWebPageStore((s) => s.addressBarFocusNonce);
  const nav = useTabsStore((s) => s.nav);
  const setPendingUrl = useWebPageStore((s) => s.setPendingUrl);
  const commitNavigate = useWebPageStore((s) => s.commitNavigate);
  const toggleInspect = useWebPageStore((s) => s.toggleInspect);
  const goBack = useTabsStore((s) => s.goBack);
  const goForward = useTabsStore((s) => s.goForward);
  const reloadOrStop = useTabsStore((s) => s.reloadOrStop);
  const zoom = useTabsStore((s) => s.zoom);
  const devtoolsOpen = useDevtoolsStore((s) => s.open);
  const devtoolsSide = useDevtoolsStore((s) => s.side);
  const findOpen = useWebPageStore((s) => s.findOpen);
  const downloadCount = useDownloadsStore((s) => s.downloads.length);
  const downloadsActive = useDownloadsStore((s) =>
    s.downloads.some((d) => d.state === 'progressing'),
  );
  const shelfOpen = useDownloadsStore((s) => s.shelfOpen);
  const openShelf = useDownloadsStore((s) => s.openShelf);
  const closeShelf = useDownloadsStore((s) => s.closeShelf);

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

  // Ctrl/Cmd+L (from either the React chrome or the focused web page, the latter
  // routed through main → browser:focus-address-bar): focus + select the bar.
  // Skip the initial 0 so a fresh canvas doesn't grab focus on mount.
  useEffect(() => {
    if (addressBarFocusNonce === 0) return;
    const el = addressInputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, [addressBarFocusNonce]);

  // A navigation drops Chromium's find session; re-run the query so an open find
  // bar's match count refreshes against the new page instead of going stale.
  useEffect(() => {
    useWebPageStore.getState().reissueFind();
  }, [nav.url]);

  // Apply the inline-autocomplete selection after the completed value renders:
  // select from the typed prefix to the end, so the next keystroke replaces the
  // suggested tail (classic address-bar behavior, no occluded dropdown needed).
  useLayoutEffect(() => {
    const from = autocompleteFromRef.current;
    if (from === null) return;
    autocompleteFromRef.current = null;
    const el = addressInputRef.current;
    if (el) el.setSelectionRange(from, el.value.length);
  }, [pendingUrl]);

  const onAddressChange = (e: ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    const inputType = (e.nativeEvent as InputEvent).inputType ?? '';
    setPendingUrl(value);
    // Complete only on insertion (never deletion) and not for multi-word search.
    if (!value || !inputType.startsWith('insert') || /\s/.test(value)) {
      autocompleteFromRef.current = null;
      return;
    }
    void window.marudesk
      .invoke('history:query', value)
      .then((entries) => {
        // Drop a stale result: the user kept typing or moved focus away.
        if (
          useWebPageStore.getState().pendingUrl !== value ||
          addressInputRef.current !== document.activeElement
        ) {
          return;
        }
        const completion = bestCompletion(value, entries);
        if (completion) {
          autocompleteFromRef.current = value.length;
          setPendingUrl(completion);
        }
      })
      .catch(() => undefined);
  };

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
              ref={addressInputRef}
              type="text"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="Search or type a URL"
              value={pendingUrl}
              onChange={onAddressChange}
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

        {nav.zoomFactor !== 1 ? (
          <button
            type="button"
            onClick={() => void zoom('reset')}
            title="Reset zoom to 100%"
            aria-label={`Zoom ${Math.round(nav.zoomFactor * 100)} percent — reset`}
            className={cn(
              'h-7 px-2 rounded-pill shrink-0 text-caption tabular-nums',
              'text-fg-secondary hover:bg-surface-2 hover:text-fg-primary',
              'transition-colors duration-fast',
            )}
          >
            {Math.round(nav.zoomFactor * 100)}%
          </button>
        ) : null}

        {downloadCount > 0 ? (
          <NavIconButton
            label={shelfOpen ? 'Hide downloads' : 'Show downloads'}
            active={shelfOpen}
            aria-pressed={shelfOpen}
            onClick={() => (shelfOpen ? closeShelf() : openShelf())}
          >
            <span className="relative inline-flex">
              <Download size={16} />
              {downloadsActive ? (
                <span className="absolute -top-1 -right-1 size-1.5 rounded-pill bg-accent animate-pulse" />
              ) : null}
            </span>
          </NavIconButton>
        ) : null}

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
          active={devtoolsOpen}
          aria-pressed={devtoolsOpen}
          onClick={() => useDevtoolsStore.getState().toggle()}
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

      {/* Find bar: a flex row between toolbar and stage. Because the web view
          tracks the (now-shorter) stage via the ResizeObserver above, it shrinks
          to fit — the bar can't be a stage overlay (the native view paints over
          React) so it sits in the chrome instead. */}
      {findOpen ? <FindBar /> : null}

      {/* Stage + DevTools dock. The dock is a flex sibling, so the stage (and
          the WebContentsView tracking it via the ResizeObserver above) shrinks
          to make room — no extra layout IPC for the steady state. */}
      <div
        className={cn(
          'flex-1 min-h-0 flex',
          devtoolsOpen && devtoolsSide === 'bottom' ? 'flex-col' : 'flex-row',
        )}
      >
        <div
          ref={containerRef}
          className={cn(
            'flex-1 min-w-0 min-h-0 relative bg-surface-1',
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
        {/* Crash recovery card. Main hides the dead web view via the layout
            engine (the view otherwise composites above this React stage), so
            this opaque overlay is what the user sees until they reload. */}
        {nav.crashed ? (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 text-center px-8 bg-surface-page">
            <span className="size-12 rounded-full bg-surface-2 text-warning flex items-center justify-center">
              <TriangleAlert size={24} />
            </span>
            <div className="flex flex-col gap-1.5">
              <h2 className="text-title text-fg-primary">This page crashed</h2>
              <p className="text-body-sm text-fg-tertiary max-w-md">
                Its process stopped unexpectedly. Reload to try loading the page
                again.
              </p>
            </div>
            <Button
              variant="secondary"
              leadingIcon={<RotateCw size={15} />}
              onClick={() => void reloadOrStop()}
            >
              Reload page
            </Button>
          </div>
        ) : null}
        </div>
        {devtoolsOpen ? <DevtoolsDock /> : null}
      </div>

      {/* Bottom download shelf — a flex sibling, so the web view shrinks up. */}
      {shelfOpen && downloadCount > 0 ? <DownloadShelf /> : null}
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

function FindBar() {
  const query = useWebPageStore((s) => s.findQuery);
  const matches = useWebPageStore((s) => s.findMatches);
  const activeMatch = useWebPageStore((s) => s.findActiveMatch);
  const focusNonce = useWebPageStore((s) => s.findFocusNonce);
  const setFindQuery = useWebPageStore((s) => s.setFindQuery);
  const findNext = useWebPageStore((s) => s.findNext);
  const closeFind = useWebPageStore((s) => s.closeFind);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus + select on open and on every re-open request (focusNonce bump).
  useEffect(() => {
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, [focusNonce]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeFind();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      findNext(!e.shiftKey); // Enter = next, Shift+Enter = previous
    }
  };

  const hasQuery = query.length > 0;
  return (
    <div className="shrink-0 px-3 py-1.5 flex items-center justify-end bg-surface-1 border-b border-subtle">
      <div className="flex items-center gap-1 h-8 rounded-md bg-surface-page border border-default pl-3 pr-1">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setFindQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Find in page"
          spellCheck={false}
          autoComplete="off"
          aria-label="Find in page"
          className="w-48 bg-transparent text-body-sm text-fg-primary placeholder:text-fg-tertiary focus:outline-none"
        />
        <span
          className="text-caption tabular-nums shrink-0 min-w-[3.5rem] text-right pr-1 text-fg-tertiary"
          aria-live="polite"
        >
          {hasQuery ? `${matches ? activeMatch : 0}/${matches}` : ''}
        </span>
        <span className="w-px h-4 bg-subtle shrink-0" aria-hidden />
        <FindBtn
          label="Previous match (Shift+Enter)"
          disabled={!matches}
          onClick={() => findNext(false)}
        >
          <ChevronUp size={15} />
        </FindBtn>
        <FindBtn
          label="Next match (Enter)"
          disabled={!matches}
          onClick={() => findNext(true)}
        >
          <ChevronDown size={15} />
        </FindBtn>
        <FindBtn label="Close find bar (Esc)" onClick={closeFind}>
          <X size={14} />
        </FindBtn>
      </div>
    </div>
  );
}

function FindBtn({
  label,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        'size-6 rounded flex items-center justify-center shrink-0 transition-colors duration-fast',
        disabled
          ? 'text-fg-tertiary opacity-40 cursor-not-allowed'
          : 'text-fg-secondary hover:bg-surface-2 hover:text-fg-primary',
      )}
    >
      {children}
    </button>
  );
}

/**
 * Best inline completion for what the user typed: the first history entry whose
 * scheme-stripped URL (or full URL) starts with the typed text. Returns the
 * value to fill — the typed prefix (preserving its casing) plus the matched
 * tail — or null when nothing prefix-matches. `entries` arrive frecency-ranked.
 */
function bestCompletion(typed: string, entries: HistoryEntry[]): string | null {
  const t = typed.toLowerCase();
  for (const e of entries) {
    const stripped = e.url.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
    if (stripped.length > typed.length && stripped.toLowerCase().startsWith(t)) {
      return typed + stripped.slice(typed.length);
    }
    if (e.url.length > typed.length && e.url.toLowerCase().startsWith(t)) {
      return typed + e.url.slice(typed.length);
    }
  }
  return null;
}
