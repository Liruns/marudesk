import { WebContentsView, app, session, type BrowserWindow } from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { type TabKind } from '../../shared/browser';
import type { WorkspaceFileRef, WorkspaceId } from '../../shared/workspace';
import {
  clearConsole,
  clearErrors,
  clearNetwork,
  clearTabs,
  deleteTab,
  getActiveTabId,
  getHost,
  getPaneBounds,
  getPaneScale,
  getTab,
  getTabGroup,
  isNetworkCaptureOn,
  nextUntitledSeq,
  pruneEmptyTabGroups,
  pushState,
  reorderTabRecords,
  setActiveTabId,
  setHost,
  setTab,
  setTabGroup,
  tabKeys,
  tabValues,
  type TabRecord,
} from './state';
import { applyWebLayout, hideTab, showTab } from './layout';
import { loadPinnedSpecs, savePinnedTabs } from './pinned-session';
import { loadTabSession, saveTabSession, saveTabSessionSync } from './tab-session';
import { closeChromeDevtools } from './devtools';
import {
  detachCdp,
  enableConsoleCapture,
  enableNetworkCapture,
  refreshErrorBadge,
} from './cdp';
import { buildWebContextMenu } from './context-menu';
import { reapplyInspectOverlay } from './inspect';
import { reapplyStageToolbar } from './stage-toolbar';
import { clearFavicon, updateFavicon } from './favicon';
import { handleFoundInPage } from './find';
import { reapplyZoom } from './zoom';
import { handleTabShortcut } from './tab-shortcuts';
import { groupContiguousOrder, pinnedFirst } from './tab-order.ts';
import { buildWebTabUserAgent } from './user-agent.ts';
export { reorderTabs, setTabPinned } from './tab-order.ts';
import { registerDownloadHandler } from './downloads';
import { recordTitle, recordVisit } from '../history';
import { openExternalUrl } from '../safe-open';
import { resolveAddressBarInput, searchBaseFor } from './url';
import { getSettingsSync } from '../settings';
import { getActiveWorkspaceId } from '../workspace';
import { getActiveProfileId } from '../profile-store';
import { webTabPartitionForProfile } from '../../shared/profiles';

/**
 * Tab lifecycle: create / activate / close / reorder, plus the mount and dispose
 * entry points. This is the package's top layer — it wires each web view's page
 * events to the layout, devtools, context-menu and inspect concerns below it.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const NEW_TAB_URL = 'about:blank';

/**
 * The web tabs' session partition, scoped to the ACTIVE profile. Electron caches
 * sessions by partition name for the process lifetime, so a fixed name would keep
 * serving the previous profile's cookies/storage across a live profile switch —
 * a per-profile name makes the switch actually swap web sign-ins too. Resolved
 * lazily (not a module constant) because the active profile changes at runtime.
 */
function webTabPartition(): string {
  return webTabPartitionForProfile(getActiveProfileId());
}

// Recently-closed restorable tabs (Ctrl/Cmd+Shift+T), newest last. Only kinds
// with meaningful state to bring back are recorded — a web page's URL and a
// saved editor file's path; transient/singleton kinds (home/terminal/…) aren't.
type ClosedTab =
  | { readonly kind: 'web'; readonly workspaceId: WorkspaceId; readonly url: string }
  | {
      readonly kind: 'editor';
      readonly workspaceId: WorkspaceId;
      readonly filePath?: string;
      readonly editorFile?: WorkspaceFileRef;
    };
const MAX_CLOSED_TABS = 10;
const closedTabs: ClosedTab[] = [];

export function createTab(
  kind: TabKind,
  initialUrl?: string,
  opts?: {
    workspaceId?: WorkspaceId;
    editorFile?: WorkspaceFileRef;
    pluginPanel?: { id: string; entry: string };
    terminalProfile?: 'agent-cli';
    devtoolsTargetTabId?: string;
  },
): TabRecord {
  const host = getHost();
  if (!host) throw new Error('createTab: host window not mounted');

  const id = randomUUID();
  const workspaceId = opts?.workspaceId ?? getActiveWorkspaceId();

  // Feature tabs carry no WebContentsView; the React stage paints them. We
  // still track them so open/close/activate and the tab strip work uniformly.
  if (kind !== 'web') {
    const filePath = kind === 'editor' ? initialUrl : undefined;
    const rec: TabRecord = {
      id,
      kind,
      workspaceId,
      view: null,
      inspectOn: false,
      filePath: opts?.editorFile?.path ?? filePath,
      editorFile: opts?.editorFile,
      pluginPanel: kind === 'plugin' ? opts?.pluginPanel : undefined,
      terminalProfile: kind === 'terminal' ? opts?.terminalProfile : undefined,
      devtoolsTargetTabId: kind === 'devtools' ? opts?.devtoolsTargetTabId : undefined,
      untitledName:
        kind === 'editor' && !filePath && !opts?.editorFile
          ? `Untitled-${nextUntitledSeq()}`
          : undefined,
    };
    setTab(id, rec);
    return rec;
  }

  const inspectSession = session.fromPartition(webTabPartition());

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

  const rec: TabRecord = { id, kind: 'web', workspaceId, view, inspectOn: false };

  view.webContents.setWindowOpenHandler(({ url }) => {
    // Open links that request a new window inside a new tab.
    if (url && /^https?:\/\//i.test(url)) {
      createAndActivateTab('web', url);
      return { action: 'deny' };
    }
    // Anything else (mailto:/tel: → OS; file:/custom schemes → refused).
    void openExternalUrl(url);
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
  // Audio activity drives the toolbar's speaker/mute affordance — push so the
  // control appears/disappears as the page starts and stops making sound.
  view.webContents.on('media-started-playing', push);
  view.webContents.on('media-paused', push);

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

  // Re-apply inspect overlay + stage toolbar after the page navigates.
  view.webContents.on('did-finish-load', () => {
    reapplyInspectOverlay(rec);
    reapplyStageToolbar(rec);
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
  view.webContents.on('before-input-event', (event, input) =>
    handleTabShortcut(rec, event, input),
  );

  // Canvas Ctrl/Cmd+wheel forwarding is driven by the in-page preload
  // (electron/inspect-preload.ts → 'canvas:web-wheel'), which alone sees the wheel
  // delta and can preventDefault the page zoom. Here we just keep the page's zoom
  // factor pinned to the canvas-driven one as a safety net (a page that somehow
  // zooms anyway snaps back), no-op off the canvas.
  view.webContents.on('zoom-changed', () => {
    if (!getPaneBounds()) return;
    const scale = getPaneScale();
    if (scale != null) view.webContents.setZoomFactor(scale);
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
  opts?: {
    workspaceId?: WorkspaceId;
    editorFile?: WorkspaceFileRef;
    pluginPanel?: { id: string; entry: string };
    terminalProfile?: 'agent-cli';
    devtoolsTargetTabId?: string;
  },
): TabRecord {
  const rec = createTab(kind, initialUrl, opts);
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
  opts?: {
    workspaceId?: WorkspaceId;
    editorFile?: WorkspaceFileRef;
    pluginPanel?: { id: string; entry: string };
    terminalProfile?: 'agent-cli';
  },
): TabRecord | null {
  const old = getTab(oldId);
  if (!old) return null;
  const order = tabKeys();
  const idx = order.indexOf(oldId);

  // Build the replacement first (appends to the map; web tabs start hidden).
  const rec = createTab(kind, initialUrl, {
    workspaceId: opts?.workspaceId ?? old.workspaceId,
    editorFile: opts?.editorFile,
    pluginPanel: opts?.pluginPanel,
    terminalProfile: opts?.terminalProfile,
  });
  // An in-place replacement keeps the old tab's group membership (it also
  // keeps the old slot, so the group's contiguous run is undisturbed).
  rec.groupId = old.groupId;

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

/** Whether a tab is hidden from the strip because its tab group is collapsed. */
function hiddenByCollapsedGroup(rec: TabRecord): boolean {
  if (!rec.groupId) return false;
  return getTabGroup(rec.groupId)?.collapsed === true;
}

export function activateTab(id: string): boolean {
  const rec = getTab(id);
  if (!rec) return false;
  // Activating a tab hidden inside a collapsed group (Ctrl+Tab cycle, the tab
  // list, "reveal this tab" flows) expands the group — the active tab must
  // always be visible in the strip, exactly like Chrome.
  if (rec.groupId) {
    const group = getTabGroup(rec.groupId);
    if (group?.collapsed) {
      setTabGroup({ ...group, collapsed: false });
      saveTabSession();
    }
  }
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
  // Feature tabs (editor/terminal/settings/…) render in the React host. After
  // hiding the previous web view, keyboard focus can stay stranded on that now-
  // hidden WebContentsView, so the editor/terminal receives no input ("can't
  // type in the file I opened"). Route focus back to the host webContents so the
  // React surface — and Monaco's own editor.focus() — actually get the keyboard.
  if (!rec.view) {
    const h = getHost();
    if (h && !h.isDestroyed()) h.webContents.focus();
  }
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
  // Record a restorable spec before tearing the view down (getURL() needs the
  // live webContents). Only web pages and saved editor files are worth reopening.
  if (rec.kind === 'web') {
    const url = rec.view?.webContents.getURL();
    if (url && url !== NEW_TAB_URL) {
      pushClosedTab({ kind: 'web', workspaceId: rec.workspaceId, url });
    }
  } else if (rec.kind === 'editor' && (rec.editorFile || rec.filePath)) {
    pushClosedTab({
      kind: 'editor',
      workspaceId: rec.workspaceId,
      filePath: rec.filePath,
      editorFile: rec.editorFile,
    });
  }
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
  // Closing a group's last member dissolves the (now empty) group record.
  pruneEmptyTabGroups();
  if (getActiveTabId() === id) {
    setActiveTabId(null);
    activateFallbackAfterClosing(rec);
  } else {
    pushState();
  }
  // Closing a pinned tab changes the restorable set.
  if (wasPinned) savePinnedTabs();
  // Any close changes the restorable session set.
  saveTabSession();
  return true;
}

function pushClosedTab(spec: ClosedTab): void {
  closedTabs.push(spec);
  if (closedTabs.length > MAX_CLOSED_TABS) closedTabs.shift();
}

function activateFallbackAfterClosing(closed: TabRecord): void {
  // Prefer a tab that is actually visible in the strip — falling back into a
  // collapsed group would silently expand it (closing the active tab inside a
  // collapsed group must not pop a different group open). Only when every
  // remaining tab is hidden do we take one anyway (activateTab expands it).
  const sameWorkspace = tabValues().filter(
    (tab) => tab.workspaceId === closed.workspaceId,
  );
  const fallback =
    sameWorkspace.find((tab) => !hiddenByCollapsedGroup(tab)) ??
    sameWorkspace[0];
  if (fallback) {
    activateTab(fallback.id);
    return;
  }
  // No tab remains in this workspace: allow the empty state (the renderer shows a
  // dedicated empty-stage screen) instead of forcing a fresh home tab. activeTabId
  // was already cleared by closeTab; just refresh so the pane re-renders empty.
  pushState();
}

/** Reopen the most recently closed tab (web page / saved editor file). */
export function reopenClosedTab(): boolean {
  const spec = closedTabs.pop();
  if (!spec) return false;
  if (spec.kind === 'web') {
    createAndActivateTab('web', spec.url, { workspaceId: spec.workspaceId });
    return true;
  }
  createAndActivateTab('editor', spec.editorFile?.path ?? spec.filePath, {
    workspaceId: spec.workspaceId,
    editorFile: spec.editorFile,
  });
  return true;
}

/** Stable partition keeping pinned tabs first; preserves order within each group. */

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

/**
 * Restore the previous session's full tab set (web pages + saved editor files) in
 * order, honoring each tab's pinned flag, then activate the tab that was active.
 * Returns whether anything was restored — when false, the caller falls back to
 * the default home tab. Gated by Settings → Data & Storage → "Restore tabs".
 */
function restoreTabSession(): boolean {
  const session = loadTabSession();
  if (session.tabs.length === 0) return false;
  const ids: string[] = [];
  // Saved groups are re-minted with fresh ids, lazily — a saved group none of
  // the restored tabs reference anymore is simply never re-created.
  const groupIds = new Map<number, string>();
  for (const spec of session.tabs) {
    const wsOpts = spec.workspaceId ? { workspaceId: spec.workspaceId } : undefined;
    let rec: ReturnType<typeof createTab>;
    if (spec.kind === 'web') {
      rec = createTab('web', spec.url || undefined, wsOpts);
    } else if (spec.kind === 'editor') {
      rec = createTab('editor', spec.filePath, wsOpts);
    } else {
      rec = createTab(spec.kind, undefined, wsOpts);
    }
    rec.pinned = spec.pinned;
    // Pinned tabs are never grouped; loadTabSession already validated indices.
    const groupIdx = spec.group;
    const saved = groupIdx !== undefined ? session.groups[groupIdx] : undefined;
    if (groupIdx !== undefined && saved && !rec.pinned) {
      let gid = groupIds.get(groupIdx);
      if (!gid) {
        gid = randomUUID();
        groupIds.set(groupIdx, gid);
        setTabGroup({
          id: gid,
          workspaceId: rec.workspaceId,
          name: saved.name,
          color: saved.color,
          collapsed: saved.collapsed,
        });
      }
      rec.groupId = gid;
    }
    ids.push(rec.id);
  }
  // Keep the pinned-first + group-contiguity invariants the strip enforces
  // everywhere else.
  reorderTabRecords(groupContiguousOrder(pinnedFirst(tabKeys())));
  let activeId = session.activeIndex >= 0 ? ids[session.activeIndex] : ids[0];
  // A session can save its active tab inside a collapsed group (collapse →
  // quit before switching). Restoring must keep that group collapsed, so
  // activate the first VISIBLE tab instead; only when every tab is hidden does
  // the saved choice win (activateTab then expands its group).
  const hidden = (id: string): boolean => {
    const rec = getTab(id);
    return !!rec && hiddenByCollapsedGroup(rec);
  };
  if (activeId && hidden(activeId)) {
    activeId = ids.find((id) => !hidden(id)) ?? activeId;
  }
  if (activeId) activateTab(activeId);
  return true;
}

export function mountBrowserView(win: BrowserWindow): void {
  setHost(win);
  // Configure the active profile's web-tab partition (permission denial).
  const inspectSession = session.fromPartition(webTabPartition());
  inspectSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });
  // Present the embedded web tabs as a plain Chrome on this OS: strip the
  // Electron/app tokens from the UA (keeping the real Chromium version) so sites
  // don't trip "unsupported browser" gates, embedded-webview sign-in blocks, or
  // anti-bot heuristics. Scoped to this web-tab partition; the host window UA is
  // internal and left untouched. See ./user-agent.
  inspectSession.setUserAgent(
    buildWebTabUserAgent(inspectSession.getUserAgent(), app.getName()),
  );
  // Track downloads originating from the web tabs (this partition), auto-saving
  // them to the Downloads folder and feeding the renderer's download shelf.
  registerDownloadHandler(inspectSession);

  // Restore the previous session. When "Restore tabs" is on we bring back the
  // full open set (and the active tab); otherwise just the pinned tabs, at the
  // front. Either way the dashboard (home) opens when nothing was restored — the
  // embedded browser only appears once a web tab exists.
  const restored = getSettingsSync().storage.persistTabs
    ? restoreTabSession()
    : (restorePinnedTabs(), false);
  if (!restored) createAndActivateTab('home');
}

/**
 * Tear down every tab view when the host window closes. The page views would
 * otherwise outlive the window, so dispose them explicitly (detaching CDP and
 * closing any built-in DevTools first).
 */
export function disposeBrowserView(): void {
  // Snapshot the latest pinned URLs/paths and the full tab session before tearing
  // the views down, so a site that was navigated mid-session restores where it
  // was left (the "Continue where you left off" moment).
  savePinnedTabs();
  saveTabSessionSync();
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
