import { ipcMain, type BrowserWindow } from 'electron';
import { type TabKind } from '../../shared/browser';
import { defineHandler } from '../ipc/define-handler';
import { arrayOf, bool, num, obj, str } from '../ipc/validate';
import {
  findTabByWebContentsId,
  getActive,
  getPaneBounds,
  getTab,
  isTabKind,
  pushState,
  snapshot,
  type Bounds,
} from './state';
import {
  clearBrowserPaneBounds,
  setBrowserBounds,
  setBrowserPaneBounds,
  setBrowserVisible,
} from './layout';
import { toggleDevtools } from './devtools';
import { exitInspect, setInspectMode } from './inspect';
import { navigateActive } from './navigation';
import {
  activateTab,
  closeTab,
  createAndActivateTab,
  reorderTabs,
} from './tabs';

/**
 * IPC registration for the browser/tab subsystem. Invoke channels go through
 * `defineHandler` (which types the return off IpcMap and channel-prefixes
 * thrown errors) + the shared validators; the two inspect:* channels are
 * fire-and-forget renderer→main messages from the inspect-preload, so they stay
 * raw `ipcMain.on` listeners.
 */

/** Validate an untrusted pixel rect (rejects non-finite values). */
function toBounds(v: unknown, field = 'bounds'): Bounds {
  const o = obj(v, field);
  return {
    x: num(o.x, `${field}.x`),
    y: num(o.y, `${field}.y`),
    width: num(o.width, `${field}.width`),
    height: num(o.height, `${field}.height`),
  };
}

export function registerBrowserHandlers(deps: {
  getMainWindow: () => BrowserWindow | null;
}): void {
  defineHandler('browser:navigate', async ([url]) => {
    await navigateActive(str(url, 'url'));
  });

  defineHandler('browser:set-bounds', ([bounds]) => {
    setBrowserBounds(toBounds(bounds));
  });

  defineHandler('browser:set-pane-bounds', ([payload]) => {
    // Untrusted renderer input — validate the whole shape before touching any
    // view. An empty `panes` array is valid (grid on, no web panes); a missing
    // or malformed array, or any bad entry, is rejected wholesale.
    const p = obj(payload);
    const panes = arrayOf(
      p.panes,
      (entry, i) => {
        const e = obj(entry, `panes[${i}]`);
        return {
          tabId: str(e.tabId, `panes[${i}].tabId`),
          rect: toBounds(e.rect, `panes[${i}].rect`),
        };
      },
      'panes',
    );
    setBrowserPaneBounds(panes);
  });

  defineHandler('browser:clear-pane-bounds', () => {
    clearBrowserPaneBounds();
  });

  defineHandler('browser:set-inspect-mode', async ([on]) => {
    await setInspectMode(bool(on, 'on'));
    pushState();
  });

  defineHandler('browser:set-visible', ([visible]) => {
    setBrowserVisible(bool(visible, 'visible'));
  });

  defineHandler('browser:go-back', () => {
    const active = getActive();
    if (!active || !active.view) return false;
    const nh = active.view.webContents.navigationHistory;
    if (!nh.canGoBack()) return false;
    nh.goBack();
    return true;
  });

  defineHandler('browser:go-forward', () => {
    const active = getActive();
    if (!active || !active.view) return false;
    const nh = active.view.webContents.navigationHistory;
    if (!nh.canGoForward()) return false;
    nh.goForward();
    return true;
  });

  defineHandler('browser:reload', () => {
    const active = getActive();
    if (!active || !active.view) return false;
    active.view.webContents.reload();
    return true;
  });

  defineHandler('browser:stop', () => {
    const active = getActive();
    if (!active || !active.view) return false;
    active.view.webContents.stop();
    return true;
  });

  // Toggle DevTools for the active web tab. Mirrors the in-page F12 handler so
  // the renderer (toolbar button / F12 while the React chrome is focused) can
  // open it too. Feature tabs have no view, so this no-ops with `false`.
  defineHandler('browser:toggle-devtools', () => {
    const active = getActive();
    if (!active || !active.view || getPaneBounds()) return false;
    toggleDevtools(active);
    return true;
  });

  defineHandler('browser:tabs-new', ([payload]) => {
    // Accept a bare url string (legacy = web navigation) or { kind, url }.
    let kind: TabKind = 'home';
    let url: string | undefined;
    if (typeof payload === 'string') {
      kind = 'web';
      url = payload;
    } else if (payload && typeof payload === 'object') {
      const p = payload as { kind?: unknown; url?: unknown; path?: unknown };
      if (isTabKind(p.kind)) {
        kind = p.kind;
      } else if (typeof p.url === 'string') {
        // A bare url with no kind means a web navigation.
        kind = 'web';
      }
      if (typeof p.url === 'string') {
        url = p.url;
      } else if (kind === 'editor' && typeof p.path === 'string') {
        // Editor tabs carry a workspace-relative file path instead of a url.
        url = p.path;
      }
    }
    const rec = createAndActivateTab(kind, url);
    return rec.id;
  });

  defineHandler('browser:tabs-close', ([id]) => closeTab(str(id, 'id')));

  defineHandler('browser:tabs-activate', ([id]) => activateTab(str(id, 'id')));

  defineHandler('browser:tabs-snapshot', () => snapshot());

  defineHandler('browser:tabs-reorder', ([ids]) => {
    reorderTabs(arrayOf(ids, (x, i) => str(x, `ids[${i}]`), 'ids'));
    return true;
  });

  defineHandler('browser:tabs-bind-path', ([payload]) => {
    const p = obj(payload);
    const id = str(p.id, 'id');
    const filePath = str(p.path, 'path');
    const rec = getTab(id);
    if (!rec || rec.kind !== 'editor') return false;
    // Bind an untitled editor tab to the path it was just saved as. The path is
    // display/title only (reads/writes re-validate it); this also retitles the
    // tab to the file's basename.
    rec.filePath = filePath;
    rec.untitledName = undefined;
    pushState();
    return true;
  });

  ipcMain.on('inspect:capture', (event, payload: unknown) => {
    const rec = findTabByWebContentsId(event.sender.id);
    if (!rec) return;
    deps.getMainWindow()?.webContents.send('browser:capture', payload);
  });

  ipcMain.on('inspect:exit', async (event) => {
    const rec = findTabByWebContentsId(event.sender.id);
    if (!rec || !rec.view) return;
    await exitInspect(rec);
    deps.getMainWindow()?.webContents.send('browser:inspect-exit');
  });
}
