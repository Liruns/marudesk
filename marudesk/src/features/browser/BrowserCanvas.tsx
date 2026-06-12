import {
  useEffect,
  useLayoutEffect,
  useRef,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { cn } from '../../lib/cn';
import { useWebPageStore } from './store';
import { useDownloadsStore } from './downloads';
import { DownloadShelf } from './DownloadShelf';
import { useTabsStore } from '../tabs/store';
import {
  clearBrowserPaneBoundsSource,
  setBrowserPaneBoundsSource,
} from '../tabs/browserPaneBounds';
import { useSettingsStore } from '../settings/store';
import { useDevtoolsStore } from '../devtools/store';
import { DevtoolsDock } from '../devtools/DevtoolsDock';
import { BrowserFindBar } from './BrowserFindBar';
import { BrowserStageOverlays } from './BrowserStageOverlays';
import { BrowserToolbar } from './BrowserToolbar';
import { useBrowserStrings } from './browserStrings';
import { AddressSuggestionsPanel } from './AddressSuggestions';
import { useAddressSuggestions } from './useAddressSuggestions';
import { BookmarksPanel } from './BookmarksPanel';
import { selectIsBookmarked, useBookmarksStore } from './bookmarks';
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
export function BrowserCanvas({ tabId }: { readonly tabId?: string } = {}) {
  const { t } = useBrowserStrings();
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
  const localTab = useTabsStore((s) =>
    tabId ? (s.tabs.find((tab) => tab.id === tabId) ?? null) : null,
  );
  const activateTab = useTabsStore((s) => s.activateTab);
  const setPendingUrl = useWebPageStore((s) => s.setPendingUrl);
  const commitNavigate = useWebPageStore((s) => s.commitNavigate);
  const toggleInspect = useWebPageStore((s) => s.toggleInspect);
  const goBack = useTabsStore((s) => s.goBack);
  const goForward = useTabsStore((s) => s.goForward);
  const reloadOrStop = useTabsStore((s) => s.reloadOrStop);
  const zoom = useTabsStore((s) => s.zoom);
  const devtoolsOpen = useDevtoolsStore((s) => s.open);
  const devtoolsSide = useDevtoolsStore((s) => s.side);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const canvasActive = !tabId || activeTabId === tabId;
  const canvasNav = localTab ?? nav;
  const displayedPendingUrl = canvasActive ? pendingUrl : canvasNav.url;
  const displayedCurrentUrl = canvasActive ? currentUrl : canvasNav.url;
  const boundsSourceId = tabId ? `single:${tabId}` : null;
  const errorCountByTab = useDevtoolsStore((s) => s.errorCountByTab);
  // Always-on console-error count for the active tab → DevTools toggle badge.
  const consoleErrorCount =
    (tabId ? errorCountByTab[tabId] : activeTabId ? errorCountByTab[activeTabId] : 0) ?? 0;
  const findOpen = useWebPageStore((s) => s.findOpen);
  const downloadCount = useDownloadsStore((s) => s.downloads.length);
  const downloadsActive = useDownloadsStore((s) =>
    s.downloads.some((d) => d.state === 'progressing'),
  );
  const shelfOpen = useDownloadsStore((s) => s.shelfOpen);
  const openShelf = useDownloadsStore((s) => s.openShelf);
  const closeShelf = useDownloadsStore((s) => s.closeShelf);
  const loadBookmarks = useBookmarksStore((s) => s.load);
  const bookmarked = useBookmarksStore(selectIsBookmarked(canvasNav.url));
  const bookmarksOpen = useBookmarksStore((s) => s.panelOpen);
  const toggleBookmarksPanel = useBookmarksStore((s) => s.togglePanel);

  const ensureActiveTab = async (): Promise<void> => {
    if (!tabId || useTabsStore.getState().activeTabId === tabId) return;
    await activateTab(tabId);
  };

  const runForTab = (action: () => void | Promise<unknown>): void => {
    void (async () => {
      await ensureActiveTab();
      await action();
    })();
  };

  // Dropdown suggestions (bookmarks + history + search) under the address bar.
  // Accepting one routes through the normal commit path so direct-URL / search
  // resolution and currentUrl bookkeeping stay identical to a typed Enter.
  const suggest = useAddressSuggestions((s) => {
    setPendingUrl(s.url);
    autocompleteFromRef.current = null;
    runForTab(commitNavigate);
  });

  // Lazy initial bookmark fetch — drives the star's filled state + the panel.
  useEffect(() => {
    void loadBookmarks();
  }, [loadBookmarks]);

  const onToggleBookmark = (): void => {
    const url = canvasNav.url || displayedCurrentUrl;
    // Mirror the store's policy: only http(s) pages can be bookmarked.
    if (!/^https?:\/\//i.test(url)) return;
    void useBookmarksStore
      .getState()
      .toggle({
        url,
        title: canvasNav.title,
        faviconUrl: canvasNav.favicon || undefined,
      })
      .catch(() => undefined);
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const sendBounds = () => {
      const rect = el.getBoundingClientRect();
      const bounds = {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      };
      if (boundsSourceId && tabId) {
        setBrowserPaneBoundsSource(boundsSourceId, [{ tabId, rect: bounds }]);
      } else {
        void window.marudesk.invoke('browser:set-bounds', bounds);
      }
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
      if (boundsSourceId) clearBrowserPaneBoundsSource(boundsSourceId);
      // Don't zero the bounds on unmount. The host hides the inactive web view
      // on tab switch, so keeping the last bounds lets the view reappear at the
      // right rect the instant we return to a web tab — no 0-size flash.
    };
  }, [boundsSourceId, tabId]);

  // Ctrl/Cmd+L (from either the React chrome or the focused web page, the latter
  // routed through main → browser:focus-address-bar): focus + select the bar.
  // Skip the initial 0 so a fresh canvas doesn't grab focus on mount.
  useEffect(() => {
    if (!canvasActive) return;
    if (addressBarFocusNonce === 0) return;
    const el = addressInputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, [addressBarFocusNonce, canvasActive]);

  // A navigation drops Chromium's find session; re-run the query so an open find
  // bar's match count refreshes against the new page instead of going stale.
  useEffect(() => {
    if (!canvasActive) return;
    useWebPageStore.getState().reissueFind();
  }, [canvasActive, canvasNav.url]);

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
    void ensureActiveTab();
    const value = e.target.value;
    const inputType = (e.nativeEvent as InputEvent).inputType ?? '';
    setPendingUrl(value);
    // Dropdown suggestions follow every edit (insert or delete), debounced.
    suggest.onInput(value);
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
    suggest.close();
    runForTab(commitNavigate);
  };

  // Arrow/Enter/Esc go to the dropdown first; unconsumed keys keep their
  // existing behavior (Enter without a selection submits the form as before).
  const onAddressKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    suggest.onKeyDown(e);
  };

  const onAddressBlur = () => {
    // Delay so a row's mousedown (which navigates) wins over the dismiss.
    window.setTimeout(() => {
      if (addressInputRef.current !== document.activeElement) suggest.close();
    }, 120);
  };

  const hasUrl = displayedCurrentUrl.length > 0 || canvasNav.url.length > 0;

  return (
    <div
      className="flex-1 min-w-0 flex flex-col bg-surface-page"
      onMouseDown={() => {
        void ensureActiveTab();
      }}
    >
      {/* Toolbar. Sits on surface-2 — the same tone as the active tab pill — so a
          web tab's chrome reads as one continuous "active surface" flowing out of
          its tab into the toolbar (Chrome/GM3), with the page stage a step darker
          below. */}
      <BrowserToolbar
        pendingUrl={displayedPendingUrl}
        currentUrl={displayedCurrentUrl}
        inspectMode={inspectMode}
        nav={canvasNav}
        addressInputRef={addressInputRef}
        downloadCount={downloadCount}
        downloadsActive={downloadsActive}
        shelfOpen={shelfOpen}
        consoleErrorCount={consoleErrorCount}
        devtoolsOpen={devtoolsOpen}
        bookmarked={bookmarked}
        bookmarksOpen={bookmarksOpen}
        onToggleBookmark={onToggleBookmark}
        onToggleBookmarksPanel={toggleBookmarksPanel}
        onAddressChange={onAddressChange}
        onAddressKeyDown={onAddressKeyDown}
        onAddressBlur={onAddressBlur}
        onSubmit={onSubmit}
        onGoBack={() => runForTab(goBack)}
        onGoForward={() => runForTab(goForward)}
        onReloadOrStop={() => runForTab(reloadOrStop)}
        onZoomReset={() => runForTab(() => zoom('reset'))}
        onToggleAudio={() =>
          runForTab(() =>
            window.marudesk.invoke('browser:set-audio-muted', !canvasNav.audioMuted),
          )
        }
        onToggleShelf={() => (shelfOpen ? closeShelf() : openShelf())}
        onToggleInspect={() => void toggleInspect()}
        onToggleDevtools={() => useDevtoolsStore.getState().toggle()}
      />

      {/* Address suggestions + bookmarks: chrome rows between toolbar and stage
          (like the find bar below) — the native view paints over React, so they
          can't float over the stage; the web view shrinks beneath them. */}
      {canvasActive ? <AddressSuggestionsPanel state={suggest} /> : null}
      {canvasActive && bookmarksOpen ? <BookmarksPanel /> : null}

      {/* Find bar: a flex row between toolbar and stage. Because the web view
          tracks the (now-shorter) stage via the ResizeObserver above, it shrinks
          to fit — the bar can't be a stage overlay (the native view paints over
          React) so it sits in the chrome instead. */}
      {findOpen ? <BrowserFindBar /> : null}

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
          aria-label={t('browser.stage.aria')}
        >
          <BrowserStageOverlays
            hasUrl={hasUrl}
            inspectMode={inspectMode}
            crashed={canvasNav.crashed}
            onReload={() => runForTab(reloadOrStop)}
          />
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
