'use strict';
const CanvasView = require('./canvas-view');

/**
 * The infinite-canvas view controller (CANVAS.md) — a thin sibling of Sidebar: it owns the canvas
 * WebContentsView's lifecycle (create / attach / detach / tear down) and nothing else. All the
 * logic — the Camera, pane world rects, gesture handling, CANVAS_STATE building — lives in
 * PaneWindow, which owns the tabs and the layout. This controller just mounts the surface and
 * relays messages to it, exactly as Sidebar does for the rail.
 *
 * Host contract (injected by PaneWindow):
 *   win        the BaseWindow
 *   onReady()  called once the canvas renderer has loaded (PaneWindow pushes the first state)
 *
 * Unlike the rail (a left inset), the canvas fills the whole content region and is kept BELOW the
 * page views in z-order by PaneWindow._restack().
 */
class Canvas {
  constructor({ win, onReady }) {
    this._win = win;
    this._onReady = onReady;
    this._view = null;
    this._enabled = false;
  }

  /** The WebContentsView (null until first enabled) — PaneWindow restacks against this. */
  get view() { return this._view ? this._view.view : null; }
  get enabled() { return this._enabled; }

  /** True if `wc` is the canvas renderer — for the window's chrome-lane sender gate. */
  isSender(wc) { return !!this._view && wc === this._view.webContents; }

  /** Attach/detach the canvas surface. Created lazily, kept for cheap re-enable (like the rail). */
  setEnabled(on) {
    on = !!on;
    if (on === this._enabled) return;
    this._enabled = on;
    if (this._win.isDestroyed()) return;
    if (on) {
      if (!this._view) this._view = new CanvasView(this._onReady);
      this._win.contentView.addChildView(this._view.view, 0); // PaneWindow._restack fixes final z
    } else if (this._view) {
      this._removeChild();
    }
  }

  /** Fill the content region with the canvas surface (right of any rail, below the chrome). */
  layout({ left, top, width, regionH }) {
    if (!this._enabled || !this._view) return;
    this._view.view.setBounds({ x: left, y: top, width: Math.max(0, width - left), height: regionH });
  }

  /** Push an event to the canvas renderer (no-op until the view exists). */
  send(channel, payload) { if (this._view) this._view.send(channel, payload); }

  /** Tear down on window close (mirrors Sidebar/DevtoolsDock). */
  destroy() {
    if (!this._view) return;
    this._removeChild();
    const wc = this._view.webContents;
    if (!wc.isDestroyed()) { try { wc.close(); } catch { /* already gone */ } }
    this._view = null;
    this._enabled = false;
  }

  _removeChild() {
    try { this._win.contentView.removeChildView(this._view.view); } catch { /* not attached */ }
  }
}

module.exports = Canvas;
