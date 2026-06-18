'use strict';
const { SIDEBAR } = require('../shared/config');
const SidebarView = require('./sidebar-view');

/**
 * The vertical-tabs rail controller (DESIGN §11). A much simpler sibling of DevtoolsDock: one
 * persistent left-rail WebContentsView (no per-tab hosts, no detach, no draggable splitter yet),
 * tiled left of the page by PaneWindow.layout(). The rail hosts the same tab list the top strip
 * does — both subscribe to TABS_STATE — so the two stay in lock-step.
 *
 * Host contract (injected by PaneWindow):
 *   win           the BaseWindow (contentView, isDestroyed)
 *   refreshTabs() re-push the current tab state (called when the rail's renderer is ready)
 *
 * width() is the page's left inset: 0 when the rail is off, else its laid-out width (which the
 * page region starts after). layout() and width() return the SAME clamped value so the page and
 * the devtools dock — which insets off width() during a splitter drag — never disagree (DESIGN §5).
 */
class Sidebar {
  constructor(host) {
    this._host = host;
    this._enabled = false;
    this._view = null;
    this._width = SIDEBAR.WIDTH;
    this._laidWidth = 0; // the width actually tiled last layout (clamped on narrow windows)
  }

  get _win() { return this._host.win; }
  get enabled() { return this._enabled; }

  /** The page's left inset — the rail's last laid-out width, 0 when off. */
  width() { return this._laidWidth; }

  /** True if `wc` is the rail's webContents — for the window's chrome-lane sender gate. */
  isSender(wc) { return !!this._view && wc === this._view.webContents; }

  /** True if the rail view currently holds keyboard focus — so disabling it can re-home focus
   *  to the page instead of orphaning it on the detached view. */
  isFocused() {
    return !!this._view && !this._view.webContents.isDestroyed() && this._view.webContents.isFocused();
  }

  /** Turn the rail on/off. Creates the view lazily on first enable and keeps it for re-enable
   *  (cheap, preserves its renderer state); detaching just removes it from the window. */
  setEnabled(on) {
    on = !!on;
    if (on === this._enabled) return;
    this._enabled = on;
    if (this._win.isDestroyed()) return;
    if (on) {
      if (!this._view) this._view = new SidebarView(() => this._host.refreshTabs());
      this._win.contentView.addChildView(this._view.view, 0); // below the chrome (overlays/palette cover it)
    } else if (this._view) {
      this._removeChild(this._view.view);
      this._laidWidth = 0;
    }
  }

  /** Tile the rail at the region's left edge; return the width consumed (the page's left inset).
   *  Yields to the page on narrow windows (never shrinks the page below SIDEBAR.MIN_PAGE) — the
   *  page is the hero (DESIGN §1/§12). */
  layout({ top, regionH, width }) {
    if (!this._enabled || !this._view) { this._laidWidth = 0; return 0; }
    const w = Math.max(0, Math.min(this._width, width - SIDEBAR.MIN_PAGE));
    this._view.view.setBounds({ x: 0, y: top, width: w, height: regionH });
    this._laidWidth = w;
    return w;
  }

  /** Push an event to the rail renderer (no-op until the view is created). */
  send(channel, payload) { if (this._view) this._view.send(channel, payload); }

  /** Tear down the rail view on window close — an explicit retire mirroring DevtoolsDock. v0 is
   *  single-window (window-GC would suffice), but this keeps the discipline for the multi-window
   *  / canvas future the codebase plans for, and matches the dock's teardown contract. */
  destroy() {
    if (!this._view) return;
    this._removeChild(this._view.view);
    const wc = this._view.webContents;
    if (!wc.isDestroyed()) { try { wc.close(); } catch { /* already gone */ } }
    this._view = null;
    this._enabled = false;
    this._laidWidth = 0;
  }

  _removeChild(view) {
    try { this._win.contentView.removeChildView(view); } catch { /* not attached */ }
  }
}

module.exports = Sidebar;
