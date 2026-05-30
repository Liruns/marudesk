import { ipcMain, type BrowserWindow } from 'electron';
import { type TabKind } from '../../shared/browser';
import { defineHandler } from '../ipc/define-handler';
import { arrayOf, bool, num, obj, str } from '../ipc/validate';
import {
  findTabByWebContentsId,
  getActive,
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
// (setBrowserBounds reused for devtools:set-dock-bounds — the drag-time path.)
import { toggleChromeDevtools } from './devtools';
import { attachCdp, detachCdp, sendCdp } from './cdp';
import { closeDevtoolsWindow, openDevtoolsWindow } from './devtools-window';
import { exitInspect, setInspectMode } from './inspect';
import { findInActive, stopFindInActive } from './find';
import { zoomActive } from './zoom';
import {
  clearInactiveDownloads,
  downloadAction,
  getDownloads,
} from './downloads';
import { navigateActive } from './navigation';
import type { DownloadAction } from '../../shared/downloads';
import {
  activateTab,
  closeTab,
  createAndActivateTab,
  reorderTabs,
  replaceTab,
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

/**
 * Resolve a tabs-new / tabs-replace payload to a { kind, url } pair. Accepts a
 * bare url string (legacy = web navigation) or { kind?, url?, path? }. A url
 * with no kind means web; an editor tab carries a workspace-relative `path`
 * instead of a url. Untrusted renderer input — the kind is validated by
 * isTabKind and the url/path are passed through to createTab (which re-resolves
 * the url and re-validates any file path on read/write).
 */
function parseTabSpec(payload: unknown): { kind: TabKind; url: string | undefined } {
  let kind: TabKind = 'home';
  let url: string | undefined;
  if (typeof payload === 'string') {
    return { kind: 'web', url: payload };
  }
  if (payload && typeof payload === 'object') {
    const p = payload as { kind?: unknown; url?: unknown; path?: unknown };
    if (isTabKind(p.kind)) kind = p.kind;
    else if (typeof p.url === 'string') kind = 'web';
    if (typeof p.url === 'string') url = p.url;
    else if (kind === 'editor' && typeof p.path === 'string') url = p.path;
  }
  return { kind, url };
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

  defineHandler('browser:reload', ([ignoreCache]) => {
    const active = getActive();
    if (!active || !active.view) return false;
    if (ignoreCache) active.view.webContents.reloadIgnoringCache();
    else active.view.webContents.reload();
    return true;
  });

  defineHandler('browser:stop', () => {
    const active = getActive();
    if (!active || !active.view) return false;
    active.view.webContents.stop();
    return true;
  });

  defineHandler('browser:find', ([payload]) => {
    const p = obj(payload);
    findInActive(str(p.text, 'text'), {
      forward: p.forward === undefined ? undefined : bool(p.forward, 'forward'),
      findNext:
        p.findNext === undefined ? undefined : bool(p.findNext, 'findNext'),
      matchCase:
        p.matchCase === undefined ? undefined : bool(p.matchCase, 'matchCase'),
    });
  });

  defineHandler('browser:stop-find', ([action]) => {
    // Coerce any unexpected value to the safe default rather than throwing.
    const a =
      action === 'keepSelection' || action === 'activateSelection'
        ? action
        : 'clearSelection';
    stopFindInActive(a);
  });

  defineHandler('browser:zoom', ([payload]) => {
    const dir = obj(payload).direction;
    // Ignore an unrecognized direction rather than destructively resetting to
    // 100% (the safe default here is "do nothing", unlike stop-find's clear).
    if (dir !== 'in' && dir !== 'out' && dir !== 'reset') {
      return getActive()?.zoomFactor ?? 1;
    }
    const factor = zoomActive(dir);
    // Reflect the new factor in NavState so the toolbar indicator updates.
    pushState();
    return factor;
  });

  defineHandler('browser:downloads-list', () => getDownloads());

  defineHandler('browser:download-action', ([payload]) => {
    const p = obj(payload);
    const id = str(p.id, 'id');
    const allowed: readonly DownloadAction[] = [
      'cancel',
      'pause',
      'resume',
      'open',
      'show',
      'remove',
    ];
    if (
      typeof p.action !== 'string' ||
      !(allowed as readonly string[]).includes(p.action)
    ) {
      return false;
    }
    return downloadAction(id, p.action as DownloadAction);
  });

  defineHandler('browser:downloads-clear', () => {
    clearInactiveDownloads();
  });

  // Custom CDP DevTools. `open`/`close` manage the debugger attach lifecycle for
  // the active web tab; the React dock shows/hides on the renderer side.
  // tabId-scoped (matching cdp-send / the event payloads) so open/close can
  // never target a different tab than the one being driven.
  defineHandler('devtools:open', ([payload]) => {
    const rec = getTab(str(obj(payload).tabId, 'tabId'));
    if (!rec || rec.kind !== 'web' || !rec.view) return false;
    attachCdp(rec);
    return true;
  });

  defineHandler('devtools:close', ([payload]) => {
    const rec = getTab(str(obj(payload).tabId, 'tabId'));
    if (!rec || rec.kind !== 'web' || !rec.view) return false;
    detachCdp(rec);
    return true;
  });

  // Escape hatch: toggle the built-in Chromium DevTools (detached window) for
  // the given tab. Detaches our CDP client first (single client per page).
  // Selected via the `'chrome'` dock setting — kept until our panels reach
  // parity on emulation / throttling / the Sources debugger.
  defineHandler('devtools:open-chrome', ([payload]) => {
    const rec = getTab(str(obj(payload).tabId, 'tabId'));
    if (!rec || rec.kind !== 'web' || !rec.view) return false;
    toggleChromeDevtools(rec);
    return true;
  });

  defineHandler('devtools:cdp-send', async ([payload]) => {
    const p = obj(payload);
    const tabId = str(p.tabId, 'tabId');
    const method = str(p.method, 'method');
    const sessionId =
      p.sessionId === undefined ? undefined : str(p.sessionId, 'sessionId');
    const params = p.params === undefined ? undefined : obj(p.params, 'params');
    // Trust the renderer-supplied tabId only after confirming it's a web tab we
    // own (the host renderer is trusted, but the debugger only exists on web).
    const rec = getTab(tabId);
    if (!rec || rec.kind !== 'web' || !rec.view) {
      return { ok: false, error: 'tab is not a web tab' };
    }
    // A command failure is a value, not a thrown error — so the renderer can
    // tell "CSS.setStyleTexts rejected" from "session is dead".
    try {
      const value = await sendCdp(rec, method, params, sessionId);
      return { ok: true, value };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  defineHandler('devtools:set-dock-bounds', ([rect]) => {
    // Drag-time path: the renderer pushes the web area rect synchronously from
    // the dock drag handler, bypassing the ResizeObserver lag. null = drag
    // ended; the normal set-bounds flow resumes.
    if (rect === null) return;
    setBrowserBounds(toBounds(rect));
  });

  // Pop the React DevTools out into its own window for the given web tab. Same
  // web-tab guard as devtools:open; the renderer dock detaches its session
  // before calling this and the popup re-attaches (single CDP client per page).
  defineHandler('devtools:popout-open', ([payload]) => {
    const tabId = str(obj(payload).tabId, 'tabId');
    const rec = getTab(tabId);
    if (!rec || rec.kind !== 'web' || !rec.view) return false;
    return openDevtoolsWindow(tabId);
  });

  defineHandler('devtools:popout-close', () => {
    closeDevtoolsWindow();
  });

  defineHandler('browser:tabs-new', ([payload]) => {
    const { kind, url } = parseTabSpec(payload);
    const rec = createAndActivateTab(kind, url);
    return rec.id;
  });

  defineHandler('browser:tabs-replace', ([payload]) => {
    const p = obj(payload);
    const id = str(p.id, 'id');
    const { kind, url } = parseTabSpec(payload);
    const rec = replaceTab(id, kind, url);
    return rec ? rec.id : null;
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
