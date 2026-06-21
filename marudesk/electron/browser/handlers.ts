import {
  Menu,
  clipboard,
  ipcMain,
  type BrowserWindow,
} from 'electron';
import { defineHandler } from '../ipc/define-handler';
import { parseNativeMenuItem, parseTabSpec, toBounds } from './handler-parse.ts';
import { arrayOf, bool, num, obj, str } from '../ipc/validate';
import { toMessage } from '../../shared/to-message';
import {
  findTabByWebContentsId,
  getActive,
  getErrors,
  getPaneBounds,
  getTab,
  pushState,
  setOccluderRect,
  snapshot,
} from './state';
import {
  applyWebLayout,
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
import { applyStageToolbar, setStageToolbarEnabled } from './stage-toolbar';
import { findInActive, stopFindInActive } from './find';
import { zoomActive } from './zoom';
import {
  clearInactiveDownloads,
  downloadAction,
  getDownloads,
} from './downloads';
import { registerBookmarkHandlers } from './bookmarks';
import { goBackTab, goForwardTab, navigateActive, navigateTab, reloadTab } from './navigation';
import { popupNativeMenu } from './native-menu';
import type { DownloadAction } from '../../shared/downloads';
import { coerceElementCapture } from '../../shared/capture';
import {
  activateTab,
  closeTab,
  createAndActivateTab,
  reopenClosedTab,
  reorderTabs,
  replaceTab,
  setTabPinned,
} from './tabs';
import {
  addTabToGroup,
  closeTabGroup,
  createTabGroupFromTab,
  dissolveTabGroup,
  moveTabToTarget,
  removeTabFromGroup,
  setTabGroupCollapsed,
  updateTabGroup,
} from './tab-groups';
import { isTabGroupColor, type TabGroupColor } from '../../shared/browser';

/**
 * IPC registration for the browser/tab subsystem. Invoke channels go through
 * `defineHandler` (which types the return off IpcMap and channel-prefixes
 * thrown errors) + the shared validators; the two inspect:* channels are
 * fire-and-forget renderer→main messages from the inspect-preload, so they stay
 * raw `ipcMain.on` listeners.
 */

/**
 * Host-side capture id source. The `inspect:capture` payload comes from a fully
 * untrusted page, so we never trust its `id` — we stamp a fresh one from this
 * monotonic counter (no Date.now()/Math.random() needed; uniqueness within a
 * session is all addCapture requires).
 */
let captureSeq = 0;
function nextCaptureId(): string {
  captureSeq += 1;
  return `cap-${captureSeq}`;
}

/** Validate an untrusted pixel rect (rejects non-finite values). */
export function registerBrowserHandlers(deps: {
  getMainWindow: () => BrowserWindow | null;
}): void {
  defineHandler('browser:navigate', async ([url]) => {
    await navigateActive(str(url, 'url'));
  });

  // Per-tab canvas controls: drive one card's view by id, leaving the active tab
  // and the grid layout untouched.
  defineHandler('browser:navigate-tab', async ([payload]) => {
    const p = obj(payload);
    await navigateTab(str(p.tabId, 'tabId'), str(p.url, 'url'));
  });

  defineHandler('browser:go-back-tab', ([tabId]) => goBackTab(str(tabId, 'tabId')));

  defineHandler('browser:go-forward-tab', ([tabId]) => goForwardTab(str(tabId, 'tabId')));

  defineHandler('browser:reload-tab', ([payload]) => {
    const p = obj(payload);
    return reloadTab(str(p.tabId, 'tabId'), p.ignoreCache === undefined ? undefined : bool(p.ignoreCache, 'ignoreCache'));
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
    // Optional canvas zoom (web views render their page at this factor so content
    // scales with the canvas). Absent/invalid → undefined (classic grid path).
    const scale =
      typeof p.scale === 'number' && Number.isFinite(p.scale) && p.scale > 0
        ? p.scale
        : undefined;
    setBrowserPaneBounds(panes, scale);
  });

  defineHandler('browser:clear-pane-bounds', () => {
    clearBrowserPaneBounds();
  });

  defineHandler('browser:set-inspect-mode', async ([on]) => {
    await setInspectMode(bool(on, 'on'));
    pushState();
  });

  // Floating in-page stage toolbar (§3.2): toggle it on/off; re-injects on
  // navigation (tabs.ts did-finish-load) while enabled. Returns the new state.
  defineHandler('browser:stage-toolbar', ([on]) => {
    const v = bool(on, 'on');
    setStageToolbarEnabled(v);
    const rec = getActive();
    if (rec && rec.view) applyStageToolbar(rec, v);
    return v;
  });

  defineHandler('browser:set-visible', ([visible]) => {
    setBrowserVisible(bool(visible, 'visible'));
  });

  defineHandler('browser:set-occluder', ([rect]) => {
    if (rect == null) {
      setOccluderRect(null);
    } else {
      const r = obj(rect, 'rect');
      setOccluderRect({
        x: num(r.x, 'rect.x'),
        y: num(r.y, 'rect.y'),
        width: num(r.width, 'rect.width'),
        height: num(r.height, 'rect.height'),
      });
    }
    applyWebLayout();
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

  defineHandler('browser:set-audio-muted', ([muted]) => {
    const active = getActive();
    if (!active || !active.view) return;
    active.view.webContents.setAudioMuted(bool(muted, 'muted'));
    // Reflect the new mute state in NavState so the toolbar control updates.
    pushState();
  });

  defineHandler('browser:capture-page', async () => {
    const active = getActive();
    if (!active || !active.view) return false;
    const image = await active.view.webContents.capturePage();
    if (image.isEmpty()) return false;
    clipboard.writeImage(image);
    return true;
  });

  defineHandler('browser:capture-page-data', async () => {
    const active = getActive();
    if (!active || !active.view) return null;
    const image = await active.view.webContents.capturePage();
    if (image.isEmpty()) return null;
    return { dataUrl: image.toDataURL() };
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

  // Bookmarks (electron/browser/bookmarks.ts) — list/add/remove/rename, with
  // the live set pushed on browser:bookmarks whenever it changes.
  registerBookmarkHandlers();

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
      return { ok: false as const, error: 'tab is not a web tab' };
    }
    // A command failure is a value, not a thrown error — so the renderer can
    // tell "CSS.setStyleTexts rejected" from "session is dead".
    try {
      const value = await sendCdp(rec, method, params, sessionId);
      return { ok: true as const, value };
    } catch (err) {
      return {
        ok: false as const,
        error: toMessage(err),
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

  // Always-on console capture (P0): drain the per-tab error ring buffer. The
  // dock seeds its console from this on open and "Fix this" reads it even when
  // the dock was never opened. Empty for a non-web tab.
  defineHandler('devtools:pull-errors', ([payload]) => {
    const rec = getTab(str(obj(payload).tabId, 'tabId'));
    if (!rec || rec.kind !== 'web' || !rec.view) return [];
    return getErrors(rec.id);
  });

  defineHandler('browser:tabs-new', ([payload]) => {
    const { kind, url, workspaceId, editorFile, pluginPanel, terminalProfile, devtoolsTargetTabId } =
      parseTabSpec(payload);
    const rec = createAndActivateTab(kind, url, {
      workspaceId,
      editorFile,
      pluginPanel,
      terminalProfile,
      devtoolsTargetTabId,
    });
    return rec.id;
  });

  defineHandler('browser:tabs-replace', ([payload]) => {
    const p = obj(payload);
    const id = str(p.id, 'id');
    const { kind, url, workspaceId, editorFile, pluginPanel, terminalProfile } =
      parseTabSpec(payload);
    const rec = replaceTab(id, kind, url, {
      workspaceId,
      editorFile,
      pluginPanel,
      terminalProfile,
    });
    return rec ? rec.id : null;
  });

  defineHandler('browser:tabs-close', ([id]) => closeTab(str(id, 'id')));

  defineHandler('browser:tabs-reopen', () => reopenClosedTab());

  defineHandler('browser:tabs-activate', ([id]) => activateTab(str(id, 'id')));

  defineHandler('browser:tabs-snapshot', () => snapshot());

  defineHandler('browser:tabs-reorder', ([ids]) => {
    reorderTabs(arrayOf(ids, (x, i) => str(x, `ids[${i}]`), 'ids'));
    return true;
  });

  defineHandler('browser:tabs-set-pinned', ([payload]) => {
    const p = obj(payload);
    return setTabPinned(str(p.id, 'id'), bool(p.pinned, 'pinned'));
  });

  // Tab groups (Chrome-style). Every verb pushes a fresh tabs snapshot, so the
  // renderer store mirrors the result; untrusted payloads are validated here.
  // An optional/unknown color falls back to the palette-cycling default rather
  // than throwing (same "coerce, don't destruct" stance as browser:zoom).
  const groupColor = (value: unknown): TabGroupColor | undefined =>
    isTabGroupColor(value) ? value : undefined;

  defineHandler('browser:tabs-move', ([payload]) => {
    const p = obj(payload);
    return moveTabToTarget(str(p.id, 'id'), str(p.targetId, 'targetId'));
  });

  defineHandler('browser:tab-groups-create', ([payload]) => {
    const p = obj(payload);
    const name = p.name === undefined ? undefined : str(p.name, 'name');
    return createTabGroupFromTab(str(p.tabId, 'tabId'), name, groupColor(p.color));
  });

  defineHandler('browser:tab-groups-add-tab', ([payload]) => {
    const p = obj(payload);
    return addTabToGroup(str(p.tabId, 'tabId'), str(p.groupId, 'groupId'));
  });

  defineHandler('browser:tab-groups-remove-tab', ([payload]) => {
    const p = obj(payload);
    return removeTabFromGroup(str(p.tabId, 'tabId'));
  });

  defineHandler('browser:tab-groups-update', ([payload]) => {
    const p = obj(payload);
    return updateTabGroup(str(p.groupId, 'groupId'), {
      name: p.name === undefined ? undefined : str(p.name, 'name'),
      color: groupColor(p.color),
    });
  });

  defineHandler('browser:tab-groups-collapse', ([payload]) => {
    const p = obj(payload);
    return setTabGroupCollapsed(
      str(p.groupId, 'groupId'),
      bool(p.collapsed, 'collapsed'),
    );
  });

  defineHandler('browser:tab-groups-dissolve', ([payload]) => {
    const p = obj(payload);
    return dissolveTabGroup(str(p.groupId, 'groupId'));
  });

  defineHandler('browser:tab-groups-close', ([payload]) => {
    const p = obj(payload);
    return closeTabGroup(str(p.groupId, 'groupId'));
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

  defineHandler('browser:popup-menu', ([payload]) => {
    const p = obj(payload);
    const win = deps.getMainWindow();
    if (!win || win.isDestroyed()) return null;
    const items = arrayOf(p.items, parseNativeMenuItem, 'items');
    return popupNativeMenu({
      window: win,
      x: num(p.x, 'x'),
      y: num(p.y, 'y'),
      items,
      buildFromTemplate: (template) => Menu.buildFromTemplate(template),
    });
  });

  ipcMain.on('inspect:capture', (event, payload: unknown) => {
    const rec = findTabByWebContentsId(event.sender.id);
    // Only a tab the user actively put into inspect mode may report a capture —
    // a background page must not be able to inject forged agent context.
    if (!rec || !rec.inspectOn) return;
    // The page payload is fully untrusted: validate + normalize to a typed
    // ElementCapture (bounded fields, fresh host-minted id) and drop anything
    // that isn't well-formed, rather than forwarding the raw blob verbatim.
    const capture = coerceElementCapture(payload, nextCaptureId);
    if (!capture) return;
    deps.getMainWindow()?.webContents.send('browser:capture', capture);
  });

  // A Ctrl/Cmd+wheel a canvas web card's preload captured (it alone sees the wheel
  // delta over the native view) → forward to the host renderer so the CANVAS zooms
  // centered on that card. The preload only sends this while the canvas owns the
  // view, so it never fires for the classic shell.
  ipcMain.on('canvas:web-wheel', (event, payload: unknown) => {
    const rec = findTabByWebContentsId(event.sender.id);
    // Only honor a wheel delta while the canvas actually owns this tab's view
    // (pane mode → the tab is a member of the pane-bounds map). Outside pane
    // mode (e.g. Mission Control / the classic shell) a page can't spoof a
    // canvas-zoom delta. The preload only sends this in pane mode anyway, so
    // this is a defense-in-depth gate on otherwise-dead-in-MC input.
    if (!rec || !getPaneBounds()?.has(rec.id)) return;
    const deltaY = (payload as { deltaY?: unknown })?.deltaY;
    deps.getMainWindow()?.webContents.send('canvas:wheel', {
      tabId: rec.id,
      deltaY: typeof deltaY === 'number' ? deltaY : 0,
    });
  });

  ipcMain.on('inspect:exit', async (event) => {
    const rec = findTabByWebContentsId(event.sender.id);
    if (!rec || !rec.view) return;
    await exitInspect(rec);
    deps.getMainWindow()?.webContents.send('browser:inspect-exit');
  });

  // Floating stage toolbar (§3.2) asked to start the picker from in-page.
  // Gate on the sender being the ACTIVE tab so a background page can't flip the
  // active tab into element-pick mode (setInspectMode always targets getActive).
  ipcMain.on('inspect:start', (event) => {
    const rec = findTabByWebContentsId(event.sender.id);
    if (!rec || !rec.view || rec !== getActive()) return;
    void setInspectMode(true);
  });
}
