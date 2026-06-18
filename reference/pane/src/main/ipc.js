'use strict';
const { ipcMain } = require('electron');
const CH = require('../shared/channels');
const history = require('./history');
const settings = require('./settings');
const session = require('./session');

/**
 * Register the toolbar→main handlers once. Each command routes to the **sender's** window
 * (resolved via `resolveWindow(sender)` — the registry's windows.fromSender), then to that
 * window's active tab where relevant. Routing per-sender — not to a single "current" window — is
 * the multi-window / canvas groundwork (DESIGN §11); with one window it resolves to that window.
 *
 * Every channel here is part of the trusted CHROME lane (the toolbar + the devtools splitter).
 * `handle`/`on` below drop any message whose sender isn't one of its own window's chrome views,
 * so a web/page view can't reach these even if it somehow obtained a raw ipcRenderer. The page
 * lane is separate (window.paneInternal, re-validated in internal-ipc.js).
 */
function registerIpc(resolveWindow) {
  const winOf = (e) => resolveWindow(e.sender);
  const tabsOf = (e) => { const w = winOf(e); return w ? w.tabs : null; };
  const active = (e) => { const t = tabsOf(e); return t ? t.active : null; };
  const onActive = (fn) => (e) => { const p = active(e); if (p) fn(p); };

  // Sender trust gate (defense-in-depth): the sender must resolve to a window that trusts it as
  // chrome. Resolving by sender first means each window only ever vouches for its own views.
  const trusted = (e) => { const w = winOf(e); return !!w && w.isTrustedChromeSender(e.sender); };
  const handle = (ch, fn) => ipcMain.handle(ch, (e, ...a) => (trusted(e) ? fn(e, ...a) : undefined));
  const on = (ch, fn) => ipcMain.on(ch, (e, ...a) => { if (trusted(e)) fn(e, ...a); });

  handle(CH.NAVIGATE, (e, url) => { const p = active(e); if (p) p.navigate(url); });
  handle(CH.BACK, onActive((p) => p.back()));
  handle(CH.FORWARD, onActive((p) => p.forward()));
  handle(CH.RELOAD, onActive((p) => p.reload()));
  handle(CH.STOP, onActive((p) => p.stop()));
  // Devtools placement is a window concern (it owns the dock layout), not a page concern.
  handle(CH.TOGGLE_DEVTOOLS, (e) => { const w = winOf(e); if (w) w.toggleDevtools(); });
  handle(CH.DEVTOOLS_SET_DOCK, (e, side) => { const w = winOf(e); if (w) w.setDevtoolsDock(side); });
  // High-frequency splitter drag uses send (not invoke) — no round-trip ack per pointermove.
  on(CH.SPLITTER_DRAG, (e, x, y) => { const w = winOf(e); if (w) w.onSplitterDrag(x, y); });
  on(CH.SPLITTER_DRAG_END, (e) => { const w = winOf(e); if (w) w.onSplitterDragEnd(); });

  handle(CH.TAB_NEW, (e) => { const t = tabsOf(e); if (t) t.newTab(); });
  handle(CH.TAB_CLOSE, (e, id) => { const t = tabsOf(e); if (t) t.closeTab(id); });
  handle(CH.TAB_ACTIVATE, (e, id) => { const t = tabsOf(e); if (t) t.activate(id); });
  handle(CH.TAB_MOVE, (e, id, pos) => { const t = tabsOf(e); if (t) t.moveTab(id, pos); });
  handle(CH.TAB_RELOAD, (e, id) => { const t = tabsOf(e); if (t) t.reloadTab(id); });
  handle(CH.TAB_DUPLICATE, (e, id) => { const t = tabsOf(e); if (t) t.duplicate(id); });
  handle(CH.TAB_CLOSE_OTHERS, (e, id) => { const t = tabsOf(e); if (t) t.closeOthers(id); });
  handle(CH.TAB_REOPEN, (e) => { const t = tabsOf(e); if (t) t.reopenClosed(); });
  handle(CH.SET_VERTICAL_TABS, (e, on) => { const w = winOf(e); if (w) w.setVerticalTabs(!!on); });

  // Infinite canvas (DESIGN §11 / CANVAS.md). Pan/zoom/move are high-frequency → send (no ack);
  // mode + raise → invoke. All resolve to the sender's window and no-op outside canvas mode.
  handle(CH.SET_CANVAS_MODE, (e, on) => { const w = winOf(e); if (w) w.setCanvasMode(!!on); });
  on(CH.CANVAS_PAN, (e, dx, dy) => { const w = winOf(e); if (w) w.onCanvasPan(dx, dy); });
  on(CH.CANVAS_ZOOM, (e, factor, ax, ay) => { const w = winOf(e); if (w) w.onCanvasZoom(factor, ax, ay); });
  on(CH.CANVAS_PANE_MOVE, (e, id, dx, dy) => { const w = winOf(e); if (w) w.onCanvasPaneMove(id, dx, dy); });
  handle(CH.CANVAS_PANE_RAISE, (e, id) => { const w = winOf(e); if (w) w.raiseCanvasPane(id); });
  handle(CH.CANVAS_FIT, (e) => { const w = winOf(e); if (w) w.fitCanvas(); });
  handle(CH.CANVAS_RESET, (e) => { const w = winOf(e); if (w) w.resetCanvas(); });
  handle(CH.CANVAS_FOCUS_PANE, (e, id) => { const w = winOf(e); if (w) w.focusCanvasPane(id); });
  on(CH.CANVAS_PANE_RESIZE, (e, id, edge, dx, dy) => { const w = winOf(e); if (w) w.onCanvasPaneResize(id, edge, dx, dy); });
  on(CH.CANVAS_PANE_FLING, (e, id, vx, vy) => { const w = winOf(e); if (w) w.onCanvasPaneFling(id, vx, vy); });
  on(CH.CANVAS_CENTER, (e, wx, wy) => { const w = winOf(e); if (w) w.centerCanvasOn(wx, wy); });
  on(CH.CANVAS_PREFS, (e, prefs) => { const w = winOf(e); if (w) w.setCanvasPrefs(prefs); });

  handle(CH.TOGGLE_MAXIMIZE, (e) => {
    const w = winOf(e);
    if (w) { w.win.isMaximized() ? w.win.unmaximize() : w.win.maximize(); }
  });
  handle(CH.SET_CHROME_HEIGHT, (e, h) => { const w = winOf(e); if (w) w.setChromeHeight(h); });
  handle(CH.FIND, (e, text, opts) => { const p = active(e); if (p) p.findInPage(text, opts); });
  handle(CH.FIND_STOP, onActive((p) => p.stopFind()));

  handle(CH.HISTORY_QUERY, (_e, input) => history.query(input));
  handle(CH.CLEAR_HISTORY, () => history.clear());

  handle(CH.GET_SETTINGS, () => settings.getAll());
  handle(CH.SET_SETTING, (_e, key, value) => {
    settings.set(key, value);
    if (key === 'restoreSession' && !value) session.clear(); // privacy: drop the saved session
  });
}

module.exports = { registerIpc };
