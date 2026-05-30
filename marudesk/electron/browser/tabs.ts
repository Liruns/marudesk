import { WebContentsView, session, shell, type BrowserWindow } from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { applyReorder, type TabKind } from '../../shared/browser';
import {
  clearTabs,
  deleteTab,
  getActiveTabId,
  getHost,
  getTab,
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
import { applyBoundsToActive, hideTab, showTab } from './layout';
import { closeChromeDevtools } from './devtools';
import { detachCdp } from './cdp';
import { buildWebContextMenu } from './context-menu';
import { reapplyInspectOverlay } from './inspect';

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
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  view.webContents.on('will-navigate', (event, navUrl) => {
    if (navUrl.startsWith('file://')) {
      event.preventDefault();
    }
  });

  const push = (): void => pushState();
  view.webContents.on('did-start-loading', push);
  view.webContents.on('did-stop-loading', push);
  view.webContents.on('did-navigate', push);
  view.webContents.on('did-navigate-in-page', push);
  view.webContents.on('page-title-updated', push);
  view.webContents.on('did-fail-load', push);

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

  // F12 / Ctrl+Shift+I while the page itself has focus. The DevTools dock is a
  // React surface the main process can't toggle directly, so we forward the
  // request to the renderer (same path as the toolbar wrench); it owns the
  // grid guard, the dock-vs-chrome choice, and the CDP attach.
  view.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    // Only the active/visible tab — a background contents must not drive the
    // dock, which always tracks the active tab.
    if (rec.id !== getActiveTabId()) return;
    const isF12 = input.key === 'F12';
    const isInspectChord =
      (input.control || input.meta) &&
      input.shift &&
      input.key.toLowerCase() === 'i';
    if (isF12 || isInspectChord) {
      event.preventDefault();
      const h = getHost();
      if (h && !h.isDestroyed()) {
        h.webContents.send('devtools:toggle', { tabId: rec.id });
      }
    }
  });

  // Detach our CDP debugger if the page's render process dies or the contents
  // is destroyed — otherwise the renderer keeps a stale 'attached' session and
  // the next cdp-send throws. No such crash handler existed before custom
  // DevTools, so this is net-new.
  view.webContents.on('render-process-gone', () => detachCdp(rec));
  view.webContents.on('destroyed', () => detachCdp(rec));

  host.contentView.addChildView(view);
  setTab(id, rec);
  // Newly-created tabs start hidden; activation makes them visible.
  hideTab(rec);

  const target = initialUrl ?? NEW_TAB_URL;
  // about:blank loads synchronously; only kick off the load for http(s).
  if (/^https?:\/\//i.test(target)) {
    void view.webContents.loadURL(target);
  } else {
    void view.webContents.loadURL('about:blank');
  }

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

export function activateTab(id: string): boolean {
  const rec = getTab(id);
  if (!rec) return false;
  const activeId = getActiveTabId();
  if (activeId === id) {
    // Re-apply bounds in case they changed while this was active.
    applyBoundsToActive();
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
  return true;
}

export function closeTab(id: string): boolean {
  const rec = getTab(id);
  if (!rec) return false;
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
  return true;
}

export function reorderTabs(orderedIds: string[]): void {
  // Reorder via the shared policy (requested order, then any unlisted tabs
  // appended), then rebuild the authoritative tab map in that order.
  const order = applyReorder(tabKeys(), orderedIds);
  reorderTabRecords(order);
  pushState();
}

export function mountBrowserView(win: BrowserWindow): void {
  setHost(win);
  // Configure inspect-partition once (permission denial).
  const inspectSession = session.fromPartition(INSPECT_PARTITION);
  inspectSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });

  // Open on the dashboard (a feature tab). The embedded browser only appears
  // once the user opens or navigates to a web tab.
  createAndActivateTab('home');
}

/**
 * Tear down every tab view when the host window closes. The page views would
 * otherwise outlive the window, so dispose them explicitly (detaching CDP and
 * closing any built-in DevTools first).
 */
export function disposeBrowserView(): void {
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
