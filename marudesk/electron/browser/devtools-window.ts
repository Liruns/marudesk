import { BrowserWindow } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getDevtoolsWindow, getHost, getTab, setDevtoolsWindow } from './state';
import { detachCdp } from './cdp';
import { openExternalUrl } from '../safe-open';

/**
 * The pop-out DevTools window: the same React renderer loaded at the hash route
 * `#/devtools/<tabId>` (App.tsx routes it to <DevtoolsWindow/>), in a normal
 * framed BrowserWindow. It mirrors the host's `webPreferences` so the preload
 * bridge (and thus `window.marudesk`) is identical — the popup drives the SAME
 * CDP relay as the dock, just bound to its own renderer.
 *
 * Single CDP client per page is preserved by the renderer handshake: the
 * in-window dock detaches before requesting the popup, and the popup re-attaches
 * on mount. CDP events follow the popup while it's open (see cdp.ts
 * `eventTarget`). Only one popup exists at a time; opening a second closes the
 * first.
 *
 * Package leaf-consumer: imports only ./state and ./cdp (both leaves), so it
 * adds no import cycle. main.ts is untouched — the base URL and preload path are
 * derived from the host window + this module's own location.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Open (or re-open) the pop-out DevTools window bound to `tabId`. Returns false
 * when the tab isn't a live web tab or the host is gone.
 */
export function openDevtoolsWindow(tabId: string): boolean {
  const rec = getTab(tabId);
  if (!rec || rec.kind !== 'web' || !rec.view) return false;
  const host = getHost();
  if (!host || host.isDestroyed()) return false;

  // Re-target an existing popup rather than stacking windows: close the old one
  // first (its 'closed' handler detaches that tab's CDP), then open fresh.
  closeDevtoolsWindow();

  // Derive the renderer base (dev server URL or file://…/index.html) from the
  // host's loaded URL; strip any existing hash so we can append our route.
  const base = host.webContents.getURL().split('#')[0];

  const win = new BrowserWindow({
    width: 900,
    height: 600,
    minWidth: 480,
    minHeight: 320,
    backgroundColor: '#08090A',
    title: 'DevTools',
    autoHideMenuBar: true,
    // Parent it to the host so Electron tears the popup down with the main
    // window (no orphaned DevTools window, and no need to touch main.ts's
    // dispose path). Non-modal — it's a normal sibling the user can move freely.
    parent: host,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });

  setDevtoolsWindow(win);

  // Refuse off-origin top-level navigation, mirroring the host window
  // (main.ts): the popup only ever does same-document hash changes, so any real
  // navigation away is diverted to the OS browser rather than loaded in this
  // trusted (bridge-carrying) renderer. Window-open is already gated globally by
  // main.ts's web-contents-created handler.
  win.webContents.on('will-navigate', (event, url) => {
    const localPrefix = process.env.VITE_DEV_SERVER_URL ?? 'file://';
    if (!url.startsWith(localPrefix)) {
      event.preventDefault();
      void openExternalUrl(url);
    }
  });

  win.once('ready-to-show', () => win.show());

  // On close: drop the popup's CDP session for the bound tab (the dock will
  // re-attach if the user re-docks) and clear the tracked window so CDP events
  // route back to the host. Guard against a stale reference if a newer popup
  // replaced this one.
  win.on('closed', () => {
    if (getDevtoolsWindow() === win) setDevtoolsWindow(null);
    const tab = getTab(tabId);
    if (tab && tab.kind === 'web' && tab.view) detachCdp(tab);
  });

  void win.loadURL(base + '#/devtools/' + tabId);
  return true;
}

/** Close the single pop-out window if open (its 'closed' handler does cleanup). */
export function closeDevtoolsWindow(): void {
  const win = getDevtoolsWindow();
  if (win && !win.isDestroyed()) win.close();
}
