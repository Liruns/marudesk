'use strict';
// Pane — preload. The single bridge between the toolbar renderer and main.
// The renderer only ever sees `window.pane`; channel names stay in shared/channels.
const { contextBridge, ipcRenderer } = require('electron');
const CH = require('../shared/channels');

contextBridge.exposeInMainWorld('pane', {
  // page actions → main (active tab)
  navigate: (url) => ipcRenderer.invoke(CH.NAVIGATE, url),
  back: () => ipcRenderer.invoke(CH.BACK),
  forward: () => ipcRenderer.invoke(CH.FORWARD),
  reload: () => ipcRenderer.invoke(CH.RELOAD),
  stop: () => ipcRenderer.invoke(CH.STOP),
  toggleDevTools: () => ipcRenderer.invoke(CH.TOGGLE_DEVTOOLS),
  setDevtoolsDock: (side) => ipcRenderer.invoke(CH.DEVTOOLS_SET_DOCK, side),

  // tab actions → main
  newTab: () => ipcRenderer.invoke(CH.TAB_NEW),
  closeTab: (id) => ipcRenderer.invoke(CH.TAB_CLOSE, id),
  activateTab: (id) => ipcRenderer.invoke(CH.TAB_ACTIVATE, id),
  moveTab: (id, pos) => ipcRenderer.invoke(CH.TAB_MOVE, id, pos),
  reloadTab: (id) => ipcRenderer.invoke(CH.TAB_RELOAD, id),
  duplicateTab: (id) => ipcRenderer.invoke(CH.TAB_DUPLICATE, id),
  closeOtherTabs: (id) => ipcRenderer.invoke(CH.TAB_CLOSE_OTHERS, id),
  reopenClosedTab: () => ipcRenderer.invoke(CH.TAB_REOPEN),
  setVerticalTabs: (on) => ipcRenderer.invoke(CH.SET_VERTICAL_TABS, on),

  // infinite canvas (DESIGN §11 / CANVAS.md). High-frequency gestures use send (no per-move ack);
  // mode + raise use invoke. Main owns the camera + world rects and pushes CANVAS_STATE back.
  setCanvasMode: (on) => ipcRenderer.invoke(CH.SET_CANVAS_MODE, on),
  canvasPan: (dx, dy) => ipcRenderer.send(CH.CANVAS_PAN, dx, dy),
  canvasZoom: (factor, ax, ay) => ipcRenderer.send(CH.CANVAS_ZOOM, factor, ax, ay),
  canvasPaneMove: (id, dx, dy) => ipcRenderer.send(CH.CANVAS_PANE_MOVE, id, dx, dy),
  canvasRaisePane: (id) => ipcRenderer.invoke(CH.CANVAS_PANE_RAISE, id),
  canvasFit: () => ipcRenderer.invoke(CH.CANVAS_FIT),
  canvasReset: () => ipcRenderer.invoke(CH.CANVAS_RESET),
  canvasFocusPane: (id) => ipcRenderer.invoke(CH.CANVAS_FOCUS_PANE, id),
  canvasPaneResize: (id, edge, dx, dy) => ipcRenderer.send(CH.CANVAS_PANE_RESIZE, id, edge, dx, dy),
  canvasPaneFling: (id, vx, vy) => ipcRenderer.send(CH.CANVAS_PANE_FLING, id, vx, vy),
  canvasCenter: (wx, wy) => ipcRenderer.send(CH.CANVAS_CENTER, wx, wy),
  setCanvasPrefs: (prefs) => ipcRenderer.send(CH.CANVAS_PREFS, prefs),
  onCanvasState: (cb) => ipcRenderer.on(CH.CANVAS_STATE, (_e, d) => cb(d)),
  onCanvasSnapshot: (cb) => ipcRenderer.on(CH.CANVAS_SNAPSHOT, (_e, d) => cb(d)),

  toggleMaximize: () => ipcRenderer.invoke(CH.TOGGLE_MAXIMIZE),
  setChromeHeight: (h) => ipcRenderer.invoke(CH.SET_CHROME_HEIGHT, h),
  queryHistory: (input) => ipcRenderer.invoke(CH.HISTORY_QUERY, input),
  getSettings: () => ipcRenderer.invoke(CH.GET_SETTINGS),
  setSetting: (key, value) => ipcRenderer.invoke(CH.SET_SETTING, key, value),
  clearHistory: () => ipcRenderer.invoke(CH.CLEAR_HISTORY),
  find: (text, opts) => ipcRenderer.invoke(CH.FIND, text, opts),
  stopFind: () => ipcRenderer.invoke(CH.FIND_STOP),
  onFound: (cb) => ipcRenderer.on(CH.FOUND_RESULT, (_e, r) => cb(r)),
  onOpenFind: (cb) => ipcRenderer.on(CH.OPEN_FIND, () => cb()),

  // events ← main
  onNavState: (cb) => ipcRenderer.on(CH.NAV_STATE, (_e, d) => cb(d)),
  onLoading: (cb) => ipcRenderer.on(CH.LOADING, (_e, d) => cb(d)),
  onDevToolsState: (cb) => ipcRenderer.on(CH.DEVTOOLS_STATE, (_e, d) => cb(d)),
  onLoadError: (cb) => ipcRenderer.on(CH.LOAD_ERROR, (_e, d) => cb(d)),
  onWindowActive: (cb) => ipcRenderer.on(CH.WINDOW_ACTIVE, (_e, d) => cb(d)),
  onFocusAddress: (cb) => ipcRenderer.on(CH.FOCUS_ADDRESS, () => cb()),
  onOpenPalette: (cb) => ipcRenderer.on(CH.OPEN_PALETTE, (_e, d) => cb(d)),
  onTabs: (cb) => ipcRenderer.on(CH.TABS_STATE, (_e, d) => cb(d)),
  onLayout: (cb) => ipcRenderer.on(CH.LAYOUT_STATE, (_e, d) => cb(d)),
  onToast: (cb) => ipcRenderer.on(CH.TOAST, (_e, m) => cb(m)),
});
