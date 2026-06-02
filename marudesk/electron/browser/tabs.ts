import { WebContentsView, session, type BrowserWindow } from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { applyReorder, type TabKind } from '../../shared/browser';
import {
  clearConsole,
  clearErrors,
  clearNetwork,
  clearTabs,
  deleteTab,
  getActiveTabId,
  getHost,
  getTab,
  isNetworkCaptureOn,
  nextUntitledSeq,
  pushState,
  reorderTabRecords,
  setActiveTabId,
  setHost,
  setTab,
  tabKeys,
  tabValues,
  type TabRecord,
} from './state';
import { applyWebLayout, hideTab, showTab } from './layout';
import { loadPinnedSpecs, savePinnedTabs } from './pinned-session';
import { closeChromeDevtools } from './devtools';
import {
  detachCdp,
  enableConsoleCapture,
  enableNetworkCapture,
  refreshErrorBadge,
} from './cdp';
import { buildWebContextMenu } from './context-menu';
import { reapplyInspectOverlay } from './inspect';
import { clearFavicon, updateFavicon } from './favicon';
import { handleFoundInPage } from './find';
import { reapplyZoom, zoomActive } from './zoom';
import { registerDownloadHandler } from './downloads';
import { recordTitle, recordVisit } from '../history';
import { openExternalUrl } from '../safe-open';
import { resolveAddressBarInput, searchBaseFor } from './url';
import { getSettingsSync } from '../settings';

/**
 * Tab lifecycle: create / activate / close / reorder, plus the mount and dispose
 * entry points. This is the package's top layer — it wires each web view's page
 * events to the layout, devtools, context-menu and inspect concerns below it.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const INSPECT_PARTITION = 'persist:inspect-target';
const NEW_TAB_URL = 'about:blank';

export function createTab(kind: TabKind, initialUrl?: string): TabRecord {
  const host = getHost();
  if (!host) throw new Error('createTab: host window not mounted');

  const id = randomUUID();

  // Feature tabs carry no WebContentsView; the React stage paints them. We
  // still track them so open/close/activate and the tab strip work uniformly.
  if (kind !== 'web') {
    const filePath = kind === 'editor' ? initialUrl : undefined;
    const rec: TabRecord = {
      id,
      kind,
      view: null,
      inspectOn: false,
      filePath,
      untitledName:
        kind === 'editor' && !filePath
          ? `Untitled-${nextUntitledSeq()}`
          : undefined,
    };
    setTab(id, rec);
    return rec;
  }

  const inspectSession = session.fromPartition(INSPECT_PARTITION);

  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'inspect-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      // `session` already pins the partition; passing both is redundant.
      session: inspectSession,
    },
  });

  view.setBackgroundColor('#0F1011');

  const rec: TabRecord = { id, kind: 'web', view, inspectOn: false };

  view.webContents.setWindowOpenHandler(({ url }) => {
    // Open links that request a new window inside a new tab.
    if (url && /^https?:\/\//i.test(url)) {
      createAndActivateTab('web', url);
      return { action: 'deny' };
    }
    // Anything else (mailto:/tel: → OS; file:/custom schemes → refused).
    openExternalUrl(url);
    return { action: 'deny' };
  });

  view.webContents.on('will-navigate', (event, navUrl) => {
    if (navUrl.startsWith('file://')) {
      event.preventDefault();
    }
  });

  const push = (): void => pushState();
  view.webContents.on('did-stop-loading', push);
  view.webContents.on('did-navigate-in-page', push);

  // Title arrives after navigation: refresh the strip and record it against the
  // current URL in history (for the address-bar autocomplete labels).
  view.webContents.on('page-title-updated', (_event, title) => {
    recordTitle(view.webContents.getURL(), title);
    pushState();
  });

  // A fresh load means the page is back: clear any crash flag from a prior
  // render-process-gone and re-reveal the view the layout engine had hidden.
  view.webContents.on('did-start-loading', () => {
    if (rec.crashed) {
      rec.crashed = false;
      applyWebLayout();
    }
    // Always-on console capture (P0): (re)attach + enable Runtime at every load
    // start — covers the initial load, crash recovery, and re-arming after the
    // built-in DevTools (which had held the single CDP client) is closed.
    enableConsoleCapture(rec);
    pushState();
  });

  // -3 (ERR_ABORTED) is a normal cancellation (navigated away / stopped / a
  // redirect superseded the load), and sub-frame failures (ads, trackers)
  // shouldn't disturb the toolbar — only a real main-frame failure updates state.
  view.webContents.on(
    'did-fail-load',
    (_event, errorCode, _desc, _url, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      pushState();
    },
  );

  // A top-level navigation lands on a new document, so the prior favicon is
  // stale — drop it (the strip shows the spinner while loading, then the globe
  // until the new icon arrives). did-navigate-in-page (SPA, same document) is a
  // plain `push` above and keeps the icon.
  view.webContents.on('did-navigate', () => {
    clearFavicon(rec);
    // Chromium resets zoom on a cross-document load; restore the tab's choice.
    reapplyZoom(rec);
    // Record the visit for address-bar autocomplete (http(s) only, filtered in
    // recordVisit). Title is best-effort here; page-title-updated refines it.
    recordVisit(view.webContents.getURL(), view.webContents.getTitle());
    // New document (main-frame nav): the old document's buffered errors are
    // stale — drop them, reset the badge, and re-enable Runtime (a navigation
    // can drop CDP domain enablement).
    clearErrors(rec.id);
    clearConsole(rec.id);
    enableConsoleCapture(rec);
    refreshErrorBadge(rec.id);
    // The new document's network is fresh too; drop the old buffer and re-enable
    // Network if the agent's read_network gate is still on for this tab.
    clearNetwork(rec.id);
    if (isNetworkCaptureOn(rec.id)) void enableNetworkCapture(rec);
    pushState();
  });

  // The page declared its icon set: fetch + inline it as a CSP-safe data URL for
  // the tab strip (see ./favicon).
  view.webContents.on('page-favicon-updated', (_event, favicons) => {
    updateFavicon(rec, favicons);
  });

  // In-page find match counts → the renderer's find bar (active tab only).
  view.webContents.on('found-in-page', (_event, result) => {
    handleFoundInPage(rec, result);
  });

  // Re-apply inspect overlay after the page navigates if inspect is on.
  view.webContents.on('did-finish-load', () => {
    reapplyInspectOverlay(rec);
  });

  // Browser-style right-click menu. Without this handler the embedded view
  // shows no context menu at all. Anchored to the host window at the cursor.
  view.webContents.on('context-menu', (_event, params) => {
    const h = getHost();
    if (!h || h.isDestroyed()) return;
    const menu = buildWebContextMenu(rec, params, (url) => {
      createAndActivateTab('web', url);
    });
    if (menu.items.length > 0) menu.popup({ window: h });
  });

  // Browser keyboard shortcuts fired while the web view itself has focus. The
  // host renderer's window keydown can't see these (focus is in a different
  // webContents), so the main process intercepts them here — the mirror of
  // Shell.tsx's handler for when the React chrome has focus. The two are
  // mutually exclusive by focus, so a shortcut never double-fires.
  view.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    // Only the active/visible tab — a background contents must not drive the
    // dock or navigation, which always track the active tab.
    if (rec.id !== getActiveTabId()) return;
    const mod = input.control || input.meta;
    const key = input.key.toLowerCase();
    const wc = rec.view?.webContents;

    // DevTools: F12 / Ctrl+Shift+I → forward to the renderer (it owns the grid
    // guard, the dock-vs-chrome choice, and the CDP attach).
    if (input.key === 'F12' || (mod && input.shift && key === 'i')) {
      event.preventDefault();
      const h = getHost();
      if (h && !h.isDestroyed()) {
        h.webContents.send('devtools:toggle', { tabId: rec.id });
      }
      return;
    }
    // Tab navigation (Ctrl+Tab / Ctrl+Shift+Tab cycle, Ctrl/Cmd+1–9 jump). The
    // renderer owns the tab list + activation, so forward the intent to the host
    // — the mirror of Shell.tsx's window keydown for the chrome-focused case.
    // Placed before the `wc` guard since these don't act on the page.
    if (input.control && input.key === 'Tab') {
      event.preventDefault();
      const h = getHost();
      if (h && !h.isDestroyed()) {
        h.webContents.send('app:tab-shortcut', {
          type: 'cycle',
          dir: input.shift ? -1 : 1,
        });
      }
      return;
    }
    if (mod && !input.shift && !input.alt && /^[1-9]$/.test(input.key)) {
      event.preventDefault();
      const h = getHost();
      if (h && !h.isDestroyed()) {
        h.webContents.send('app:tab-shortcut', {
          type: 'jump',
          digit: Number(input.key),
        });
      }
      return;
    }
    // Split-pane shortcuts: Ctrl+Alt+Arrow cycles pane focus, Ctrl+Shift+Enter
    // zooms the focused pane. No-ops in the renderer when there's no split.
    if (input.control && input.alt && (input.key === 'ArrowLeft' || input.key === 'ArrowRight' || input.key === 'ArrowUp' || input.key === 'ArrowDown')) {
      event.preventDefault();
      const h = getHost();
      const dir = input.key === 'ArrowLeft' || input.key === 'ArrowUp' ? -1 : 1;
      if (h && !h.isDestroyed()) {
        h.webContents.send('app:tab-shortcut', { type: 'pane-cycle', dir });
      }
      return;
    }
    if (input.control && input.shift && input.key === 'Enter') {
      event.preventDefault();
      const h = getHost();
      if (h && !h.isDestroyed()) {
        h.webContents.send('app:tab-shortcut', { type: 'pane-maximize' });
      }
      return;
    }
    if (!wc) return;

    // Reload: F5 / Ctrl+R (normal), Ctrl+Shift+R (hard, ignore cache).
    if (input.key === 'F5' || (mod && key === 'r')) {
      event.preventDefault();
      if (mod && input.shift && key === 'r') wc.reloadIgnoringCache();
      else wc.reload();
      return;
    }
    // History: Alt+Left / Alt+Right.
    if (input.alt && (input.key === 'ArrowLeft' || input.key === 'ArrowRight')) {
      event.preventDefault();
      const nh = wc.navigationHistory;
      if (input.key === 'ArrowLeft') {
        if (nh.canGoBack()) nh.goBack();
      } else if (nh.canGoForward()) {
        nh.goForward();
      }
      return;
    }
    // Focus the address bar: Ctrl/Cmd+L. Pull keyboard focus to the host
    // renderer first (it's in the embedded view right now), then ask it to focus
    // + select the address input.
    if (mod && key === 'l') {
      event.preventDefault();
      const h = getHost();
      if (h && !h.isDestroyed()) {
        h.webContents.focus();
        h.webContents.send('browser:focus-address-bar');
      }
      return;
    }
    // Find in page: Ctrl/Cmd+F → pull focus to the host and open the find bar.
    if (mod && key === 'f') {
      event.preventDefault();
      const h = getHost();
      if (h && !h.isDestroyed()) {
        h.webContents.focus();
        h.webContents.send('browser:open-find');
      }
      return;
    }
    // Page zoom: Ctrl/Cmd with '=' / '+' (in), '-' (out), '0' (reset). pushState
    // carries the new factor to the toolbar indicator.
    if (mod && (input.key === '=' || input.key === '+')) {
      event.preventDefault();
      zoomActive('in');
      pushState();
      return;
    }
    if (mod && (input.key === '-' || input.key === '_')) {
      event.preventDefault();
      zoomActive('out');
      pushState();
      return;
    }
    if (mod && input.key === '0') {
      event.preventDefault();
      zoomActive('reset');
      pushState();
      return;
    }
  });

  // Detach our CDP debugger if the page's render process dies or the contents
  // is destroyed — otherwise the renderer keeps a stale 'attached' session and
  // the next cdp-send throws. No such crash handler existed before custom
  // DevTools, so this is net-new.
  view.webContents.on('render-process-gone', (_event, details) => {
    detachCdp(rec);
    // 'clean-exit' is orderly teardown (e.g. closeTab closing the view), not a
    // crash. Anything else (crashed / oom / killed / launch-failed) leaves a dead
    // view: flag it, hide it via the layout engine, and let the renderer paint a
    // recovery card. Cleared on the next load (did-start-loading).
    if (details.reason === 'clean-exit') return;
    rec.crashed = true;
    hideTab(rec);
    pushState();
  });
  view.webContents.on('destroyed', () => detachCdp(rec));

  // The built-in Chromium DevTools (escape hatch) holds the single per-page CDP
  // client while open. When it closes — via our toggle OR the user closing its
  // window directly — re-arm always-on capture so the error badge/buffer don't
  // stay dark until the next navigation.
  view.webContents.on('devtools-closed', () => {
    rec.chromeDevtoolsOpen = false;
    enableConsoleCapture(rec);
  });

  host.contentView.addChildView(view);
  setTab(id, rec);
  // Newly-created tabs start hidden; activation makes them visible.
  hideTab(rec);

  // Resolve raw input the same way the address bar does, so "google.com" or a
  // bare search query opened from the New Tab page actually navigates instead of
  // landing on about:blank (the old `/^https?/` gate only loaded explicit URLs).
  // resolveAddressBarInput returns '' for empty, 'about:blank', or a loadable
  // http(s)/search URL — so `|| NEW_TAB_URL` covers the blank-tab case.
  const resolved = initialUrl
    ? resolveAddressBarInput(
        initialUrl,
        searchBaseFor(getSettingsSync().browser.searchEngine),
      )
    : '';
  void view.webContents.loadURL(resolved || NEW_TAB_URL);

  return rec;
}

export function createAndActivateTab(
  kind: TabKind,
  initialUrl?: string,
): TabRecord {
  const rec = createTab(kind, initialUrl);
  activateTab(rec.id);
  return rec;
}

/**
 * Replace tab `oldId` in place with a fresh tab of `kind` (optionally loading
 * `initialUrl`), keeping the old tab's slot in the strip. This is what the New
 * Tab page uses so clicking a launcher (or entering a URL) turns *that* tab into
 * the chosen kind instead of spawning a second tab beside it.
 *
 * The replacement gets a new id (a web tab needs a freshly-wired WebContentsView,
 * which createTab builds), so we slot it into the old index and dispose the old
 * record. Returns the new record, or null if `oldId` no longer exists.
 */
export function replaceTab(
  oldId: string,
  kind: TabKind,
  initialUrl?: string,
): TabRecord | null {
  const old = getTab(oldId);
  if (!old) return null;
  const order = tabKeys();
  const idx = order.indexOf(oldId);

  // Build the replacement first (appends to the map; web tabs start hidden).
  const rec = createTab(kind, initialUrl);

  // Tear the old tab down (web view + any DevTools); feature tabs have none.
  detachCdp(old);
  closeChromeDevtools(old);
  if (old.view) {
    try {
      getHost()?.contentView.removeChildView(old.view);
    } catch {
      // ignore if already removed
    }
    old.view.webContents.close();
  }
  const wasActive = getActiveTabId() === oldId;
  deleteTab(oldId);

  // Slot the replacement into the old position so the strip doesn't jump.
  if (idx >= 0) {
    const next = order.slice();
    next.splice(idx, 1, rec.id);
    reorderTabRecords(next);
  }

  // Activate the replacement when it took over the active slot (the common
  // case — converting the active New Tab); otherwise just refresh the strip.
  if (wasActive) activateTab(rec.id);
  else pushState();
  return rec;
}

export function activateTab(id: string): boolean {
  const rec = getTab(id);
  if (!rec) return false;
  const activeId = getActiveTabId();
  if (activeId === id) {
    // Re-apply layout in case bounds changed while this was active. MUST go
    // through applyWebLayout, NOT applyBoundsToActive: in grid mode the latter
    // yanks this view to the single-view full-stage rect, occluding the whole
    // split — the "click the already-active browser chip and it covers the grid"
    // bug. applyWebLayout keeps grid panes at their rects when grid mode is on.
    applyWebLayout();
    return true;
  }
  // Hide the previous active web view (feature tabs have nothing to hide).
  if (activeId) {
    const prev = getTab(activeId);
    if (prev) hideTab(prev);
  }
  setActiveTabId(id);
  // Show the web view; feature tabs render in the React stage instead.
  showTab(rec);
  pushState();
  // Re-assert this tab's error count so the badge reconciles on every switch
  // (and recovers if the host renderer remounted and lost its in-memory map).
  if (rec.kind === 'web') refreshErrorBadge(rec.id);
  return true;
}

export function closeTab(id: string): boolean {
  const rec = getTab(id);
  if (!rec) return false;
  const wasPinned = !!rec.pinned;
  // Detach our CDP debugger and tear down any built-in DevTools before the page
  // view goes away (detach before webContents.close).
  detachCdp(rec);
  closeChromeDevtools(rec);
  // Tear down the WebContentsView for web tabs; feature tabs have none.
  if (rec.view) {
    try {
      getHost()?.contentView.removeChildView(rec.view);
    } catch {
      // ignore if already removed
    }
    rec.view.webContents.close();
  }
  deleteTab(id);
  if (getActiveTabId() === id) {
    setActiveTabId(null);
    // Activate adjacent tab if available.
    const next = tabValues()[0];
    if (next) {
      activateTab(next.id);
    } else {
      // No tabs left — open a fresh New Tab (home) so the stage isn't dead.
      createAndActivateTab('home');
    }
  } else {
    pushState();
  }
  // Closing a pinned tab changes the restorable set.
  if (wasPinned) savePinnedTabs();
  return true;
}

/** Stable partition keeping pinned tabs first; preserves order within each group. */
function pinnedFirst(ids: string[]): string[] {
  return [
    ...ids.filter((id) => getTab(id)?.pinned),
    ...ids.filter((id) => !getTab(id)?.pinned),
  ];
}

export function reorderTabs(orderedIds: string[]): void {
  // Reorder via the shared policy (requested order, then any unlisted tabs
  // appended), then keep pinned tabs anchored at the front before rebuilding the
  // authoritative tab map — a drag can't drop an ordinary tab ahead of a pin.
  const order = pinnedFirst(applyReorder(tabKeys(), orderedIds));
  reorderTabRecords(order);
  pushState();
}

/**
 * Pin/unpin a tab. Pinned tabs render favicon-only and stay at the front of the
 * strip, so flipping the flag re-sorts pinned-first (Chrome/Edge "Pin tab").
 */
export function setTabPinned(id: string, pinned: boolean): boolean {
  const rec = getTab(id);
  if (!rec) return false;
  if (!!rec.pinned === pinned) return true;
  rec.pinned = pinned;
  reorderTabRecords(pinnedFirst(tabKeys()));
  pushState();
  savePinnedTabs();
  return true;
}

/**
 * Recreate the pinned tabs saved from a previous session, in order, so they sit
 * at the front of the strip before the default home tab is opened. Web pins
 * reload their URL; editor pins re-bind their file path. Called once at mount.
 */
function restorePinnedTabs(): void {
  for (const spec of loadPinnedSpecs()) {
    const rec =
      spec.kind === 'web'
        ? createTab('web', spec.url || undefined)
        : createTab('editor', spec.filePath);
    rec.pinned = true;
  }
}

export function mountBrowserView(win: BrowserWindow): void {
  setHost(win);
  // Configure inspect-partition once (permission denial).
  const inspectSession = session.fromPartition(INSPECT_PARTITION);
  inspectSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });
  // Track downloads originating from the web tabs (this partition), auto-saving
  // them to the Downloads folder and feeding the renderer's download shelf.
  registerDownloadHandler(inspectSession);

  // Restore last session's pinned tabs at the front, then open on the dashboard
  // (a feature tab). The embedded browser only appears once a web tab exists.
  restorePinnedTabs();
  createAndActivateTab('home');
}

/**
 * Tear down every tab view when the host window closes. The page views would
 * otherwise outlive the window, so dispose them explicitly (detaching CDP and
 * closing any built-in DevTools first).
 */
export function disposeBrowserView(): void {
  // Snapshot the latest pinned URLs/paths before tearing the views down, so a
  // pinned site that was navigated mid-session restores where it was left.
  savePinnedTabs();
  for (const rec of tabValues()) {
    detachCdp(rec);
    closeChromeDevtools(rec);
    if (rec.view) {
      try {
        getHost()?.contentView.removeChildView(rec.view);
      } catch {
        // ignore
      }
      try {
        rec.view.webContents.close();
      } catch {
        // ignore
      }
    }
  }
  clearTabs();
  setActiveTabId(null);
  setHost(null);
}
