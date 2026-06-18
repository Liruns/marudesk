'use strict';
const { BaseWindow } = require('electron');
const { CHROME_HEIGHT, COLORS, DEVTOOLS } = require('../shared/config');
const SplitterView = require('./splitter-view');
const settings = require('./settings');

/**
 * Docked-devtools orchestration (DESIGN §4), extracted from PaneWindow so the window file owns only
 * window lifecycle + layout + tab bridging. This controller owns everything about *where* a tab's
 * devtools live: the docked host view, the draggable splitter, the per-tab detached satellites, and
 * the persisted side/size. It manipulates the window's contentView but never the page-layout math —
 * that stays in PaneWindow.layout(), which delegates the page region here via layoutInto().
 *
 * Host contract (injected by PaneWindow):
 *   win              the BaseWindow (contentView, getContentBounds, isDestroyed)
 *   getActiveView()  the active PageView, or null
 *   relayout()       force a full re-tile (PaneWindow nulls its bounds cache, then layout())
 *   sendState(p)     push { open, dock } to the toolbar
 *
 * reconcile() is the single idempotent reducer: it makes the window contain exactly the host +
 * splitter the ACTIVE tab wants, then relays out. Every mutation (toggle, dock change, tab switch,
 * tab/satellite close) ends by calling it, so there is one place that defines truth.
 */
class DevtoolsDock {
  constructor(host) {
    this._host = host;
    // `_dockPref` is the side a plain toggle opens to; `_dockSize` holds the per-axis extent
    // (persisted). `_dockSide`/`_dockedHost`/`_splitter` track what the window currently shows for
    // the ACTIVE tab; `_satellites` maps a PageView → its detached window.
    this._dockPref = settings.get('devtoolsDock') || 'right';
    this._dockSize = {
      right: settings.get('devtoolsSizeRight') || DEVTOOLS.DEFAULT_RIGHT,
      bottom: settings.get('devtoolsSizeBottom') || DEVTOOLS.DEFAULT_BOTTOM,
    };
    this._dockSide = null;        // 'right' | 'bottom' | null (detach is windowed, not docked)
    this._dockedHost = null;      // the active tab's devtools host view, while docked
    this._splitter = null;        // the draggable gutter view (created on first dock)
    this._splitterShown = false;
    this._satellites = new Map(); // PageView → BaseWindow (detached devtools)
    // wc → { x, y } target while an inspect waits for `devtools-opened`. Keyed by webContents so a
    // re-entrant inspect retargets the pending pair instead of stacking a second listener pair
    // (a WeakMap so a wc that somehow never opens/destroys can't pin its entry). See inspectElement().
    this._pendingInspect = new WeakMap();
  }

  get _win() { return this._host.win; }

  /* ── Layout ──────────────────────────────────────────────────────────────── */

  /** The docked devtools' extent along its split axis, clamped so the PAGE always keeps MIN_PAGE.
   *  The page is the hero (DESIGN §1/§12): when the window is too small to honor both minimums the
   *  DOCK yields first (it may drop below MIN) rather than starving the page below MIN_PAGE. `span`
   *  is the full axis length (window width for a right dock, region height for a bottom dock).
   *  Shared by layoutInto() and onSplitterDrag() so rendered and persisted sizes can never diverge. */
  _clampDock(desired, span) {
    const maxDock = Math.max(0, span - DEVTOOLS.MIN_PAGE - DEVTOOLS.SPLITTER);
    const minDock = Math.min(DEVTOOLS.MIN, maxDock);
    return Math.max(minDock, Math.min(desired, maxDock));
  }

  /** Pure geometry: the page / splitter / host rects for `region` given the current dock side+size,
   *  or `{ docked:false }` when nothing is docked. Shared by layoutInto (tabs) and the canvas-mode
   *  reserve below so rendered/persisted sizes can never diverge. The page never starts before `left`
   *  (the rail inset), so rail and dock can't overlap. Synchronous for resize integrity (DESIGN §5). */
  _dockRects({ left = 0, top, width, regionH }) {
    const host = this._dockedHost;
    const S = DEVTOOLS.SPLITTER;
    const availW = Math.max(0, width - left); // region width after the rail inset
    if (this._dockSide === 'right' && host) {
      const dockW = this._clampDock(this._dockSize.right, availW);
      const pageW = Math.max(0, availW - dockW - S);
      return {
        docked: true,
        page: { x: left, y: top, width: pageW, height: regionH },
        splitter: { x: left + pageW, y: top, width: S, height: regionH },
        host: { x: left + pageW + S, y: top, width: dockW, height: regionH },
      };
    }
    if (this._dockSide === 'bottom' && host) {
      const dockH = this._clampDock(this._dockSize.bottom, regionH);
      const pageH = Math.max(0, regionH - dockH - S);
      return {
        docked: true,
        page: { x: left, y: top, width: availW, height: pageH },
        splitter: { x: left, y: top + pageH, width: availW, height: S },
        host: { x: left, y: top + pageH + S, width: availW, height: dockH },
      };
    }
    return { docked: false };
  }

  /** Tile page │ splitter │ host (tabs mode): position all three and return true, else false (the
   *  caller fills the region with the page). Behavior is identical to the pre-refactor inline math. */
  layoutInto(page, region) {
    const r = this._dockRects(region);
    if (!r.docked) return false;
    page.setBounds(r.page);
    if (this._splitter) this._splitter.view.setBounds(r.splitter);
    this._dockedHost.setBounds(r.host);
    return true;
  }

  /** The sub-region left for the canvas after reserving any docked devtools (CANVAS.md). Pure — no
   *  side effects — so PaneWindow can ask for it from gesture/push paths without moving the dock.
   *  Expressed in the canvas region convention ({left, top, width=right-edge, regionH}). */
  canvasRegionOf(region) {
    const r = this._dockRects(region);
    if (!r.docked) return region;
    return { left: r.page.x, top: r.page.y, width: r.page.x + r.page.width, regionH: r.page.height };
  }

  /** Canvas mode: position the docked devtools host + splitter (if any) and return the canvas
   *  sub-region. Unlike layoutInto it doesn't position a "page" — in canvas mode the active pane is
   *  tiled by CanvasLayout within the returned sub-region, floating on the surface. */
  placeDockForCanvas(region) {
    const r = this._dockRects(region);
    if (r.docked) {
      if (this._splitter) this._splitter.view.setBounds(r.splitter);
      this._dockedHost.setBounds(r.host);
    }
    return this.canvasRegionOf(region);
  }

  /* ── Reconcile (the reducer) ───────────────────────────────────────────────── */

  reconcile() {
    const win = this._win;
    if (win.isDestroyed()) return;
    const view = this._host.getActiveView();
    const mode = view ? view.devtoolsMode : null;
    const wantDocked = mode === 'right' || mode === 'bottom';
    const host = view ? view.devtoolsView : null;
    const desiredHost = wantDocked ? host : null;
    const desiredSide = wantDocked ? mode : null;

    // Early-out when the dock structure already matches (e.g. the redundant second reconcile a tab
    // switch fires after _setActiveView): no attach/detach, no forced relayout. Idempotent either
    // way; this just skips the wasted contentView churn + setBounds×3.
    if (this._dockedHost === desiredHost && this._dockSide === desiredSide && this._splitterShown === wantDocked) return;

    // Drop a stale docked host (devtools closed, switched to detach, or a different tab's host).
    if (this._dockedHost && this._dockedHost !== desiredHost) {
      this._removeChild(this._dockedHost);
      this._dockedHost = null;
    }
    if (wantDocked && host && this._dockedHost !== host) {
      win.contentView.addChildView(host, 0); // below the chrome, so overlay menus stay on top
      this._dockedHost = host;
    }
    if (wantDocked) this._showSplitter(mode); else this._hideSplitter();

    this._dockSide = desiredSide;
    this._host.relayout(); // dock geometry changed — force a re-tile
  }

  /** reconcile + re-announce, for the tab-switch / open / close edges. */
  refresh() { this.reconcile(); this.emitState(); }

  _showSplitter(mode) {
    if (!this._splitter) this._splitter = new SplitterView();
    this._splitter.setOrientation(mode === 'bottom' ? 'row' : 'col');
    if (!this._splitterShown) {
      this._win.contentView.addChildView(this._splitter.view, 0);
      this._splitterShown = true;
    }
  }

  _hideSplitter() {
    if (this._splitter && this._splitterShown) {
      this._removeChild(this._splitter.view);
      this._splitterShown = false;
    }
  }

  /* ── Open / move / close ───────────────────────────────────────────────────── */

  /** Toolbar/keyboard toggle: open devtools at the preferred side, or close it if already open. */
  toggle() {
    const view = this._host.getActiveView();
    if (!view) return;
    if (view.isDevToolsOpen()) this._closeActive(view);
    else this.setDock(this._dockPref);
  }

  /** Open or move the active tab's devtools to `side` ('right' | 'bottom' | 'detach'). */
  setDock(side) {
    const view = this._host.getActiveView();
    if (!view) return;
    if (side !== 'right' && side !== 'bottom' && side !== 'detach') side = 'right'; // guard bad input
    // Detach is a transient per-session choice; only a docked side is remembered as the toggle
    // target, so a plain Ctrl+Shift+I after restart re-docks rather than silently spawning a window.
    if (side !== 'detach') this._dockPref = side;
    const prev = view.devtoolsMode;
    view.setMode(side);
    if (side === 'detach') {
      this._detachHost(view);     // pull the host out of the window before it moves into its own
      this._detachToSatellite(view);
      view.ensureOpen();          // no-op if already open — a re-dock just relocates the live session
      this.reconcile();           // drops the docked host/splitter, lays the page out full
    } else {
      if (prev === 'detach') this._closeSatellite(view); // reclaim the host from its window
      this.reconcile();           // attach host + splitter so the contents have somewhere to render
      view.ensureOpen();
    }
    this._persist();
    this.emitState();
  }

  /** Right-click → Inspect Element. Open this tab's devtools in Pane's managed host (never Chromium's
   *  own docked window) at the preferred side, then point the inspector at (x, y). If a session is
   *  already live, inspect immediately; otherwise inspect once it opens — calling inspectElement
   *  before the front-end attaches would make Chromium spawn its own docked devtools, bypassing the
   *  host machinery. Coords are page-local (from the context-menu params), exactly what it expects. */
  inspectElement(x, y) {
    const view = this._host.getActiveView();
    if (!view) return;
    const wc = view.webContents;
    if (wc.isDestroyed()) return;
    const px = Math.round(x), py = Math.round(y);
    if (wc.isDevToolsOpened()) { wc.inspectElement(px, py); return; }
    // Inspect once devtools attaches. If an inspect is already pending for this wc (devtools opening
    // but the front-end not yet attached), just retarget it — registering a second pair would leak
    // listeners toward Node's MaxListenersExceededWarning if `devtools-opened` somehow never fired and
    // the tab never closed. The pair clears itself (and the pending entry) on whichever of open /
    // teardown comes first; each handler also drops the other so nothing dangles.
    const pending = this._pendingInspect.get(wc);
    if (pending) { pending.x = px; pending.y = py; return; }
    const target = { x: px, y: py };
    this._pendingInspect.set(wc, target);
    const done = () => {
      this._pendingInspect.delete(wc);
      wc.removeListener('devtools-opened', onOpened);
      wc.removeListener('destroyed', onDestroyed);
    };
    const onOpened = () => { done(); if (!wc.isDestroyed()) wc.inspectElement(target.x, target.y); };
    const onDestroyed = done;
    wc.once('devtools-opened', onOpened);
    wc.once('destroyed', onDestroyed);
    this.setDock(this._dockPref); // setMode + reconcile + ensureOpen, at the remembered side
  }

  /** A tab closed: drop its dock/satellite and retire its host so nothing dangles. */
  teardown(view) { this._dispose(view); }

  _closeActive(view) {
    this._dispose(view);
    this.reconcile();
    this.emitState();
  }

  /** Common teardown: drop the satellite, pull the docked host, end the session, retire the host. */
  _dispose(view) {
    this._closeSatellite(view);
    this._detachHost(view);
    view.closeDevtools();
    view.destroyDtHost();
  }

  /* ── Detach (satellite window) ─────────────────────────────────────────────── */

  /** Reparent a tab's devtools host into its own window (the 'detach' mode). */
  _detachToSatellite(view) {
    const host = view.devtoolsView;
    if (!host) return;
    let sat = this._satellites.get(view);
    if (sat) { sat.focus(); return; }
    sat = new BaseWindow({ width: 800, height: 600, minWidth: 400, minHeight: 300, title: 'DevTools — Pane', backgroundColor: COLORS.canvas });
    sat.contentView.addChildView(host);
    const fit = () => {
      if (sat.isDestroyed()) return;
      const b = sat.getContentBounds();
      host.setBounds({ x: 0, y: 0, width: b.width, height: b.height });
    };
    fit();
    sat.on('resize', fit);
    sat.on('close', () => {
      this._satellites.delete(view);
      view.closeDevtools(); // closing the window ends the session
      this.reconcile();
      this.emitState();
    });
    this._satellites.set(view, sat);
  }

  /** Destroy a tab's satellite window WITHOUT ending the session (used when re-docking). */
  _closeSatellite(view) {
    const sat = this._satellites.get(view);
    if (!sat) return;
    this._satellites.delete(view);
    sat.removeAllListeners('close'); // don't let destroy() re-enter reconcile/emitState
    const host = view.devtoolsView;
    if (host) { try { sat.contentView.removeChildView(host); } catch { /* not attached */ } }
    try { sat.destroy(); } catch { /* gone */ }
  }

  /* ── Splitter drag ─────────────────────────────────────────────────────────── */

  /** Splitter drag (screen coords): turn the pointer into an exact dock extent, then re-tile. */
  onSplitterDrag(x, y) {
    const win = this._win;
    if (!this._dockSide || win.isDestroyed()) return;
    const b = win.getContentBounds();
    // Pointer distance from the dock's OUTER edge = desired extent; _clampDock keeps the page's
    // MIN_PAGE so this agrees with layoutInto(). Screen coords make it immune to the splitter sliding
    // under the cursor mid-drag, and to the window being moved during the drag. The vertical-tabs
    // rail (on the LEFT) doesn't move the right dock's outer edge, but it shrinks the region the
    // page lives in, so the right-dock clamp span subtracts the rail inset — matching layoutInto's
    // availW so the rendered and persisted sizes can't diverge (DESIGN §5).
    const inset = this._host.getInset ? this._host.getInset() : 0;
    const next = this._dockSide === 'right'
      ? this._clampDock((b.x + b.width) - x, b.width - inset)
      : this._clampDock((b.y + b.height) - y, b.height - (CHROME_HEIGHT - 1));
    if (this._dockSize[this._dockSide] === next) return; // clamped to the same extent — skip the re-tile
    this._dockSize[this._dockSide] = next;
    this._host.relayout();
  }

  onSplitterDragEnd() { this._persist(); }

  /* ── Persistence / state / lifecycle ───────────────────────────────────────── */

  _persist() {
    settings.set('devtoolsDock', this._dockPref);
    settings.set('devtoolsSizeRight', this._dockSize.right);
    settings.set('devtoolsSizeBottom', this._dockSize.bottom);
  }

  emitState() {
    const view = this._host.getActiveView();
    const mode = view ? view.devtoolsMode : null;
    this._host.sendState({ open: mode !== null, dock: mode });
  }

  /** True if `wc` is the splitter's webContents — for the window's chrome-lane sender gate. */
  isSplitterSender(wc) { return !!this._splitter && wc === this._splitter.view.webContents; }

  /** Window is closing: take any detached devtools windows down with it and retire every tab's host
   *  so nothing outlives the window (the OS 'X' doesn't route through TabManager teardown). Drop the
   *  satellites' 'close' listeners first so teardown doesn't re-enter reconcile against a dying window. */
  handleWindowClosed(tabs) {
    for (const sat of this._satellites.values()) { sat.removeAllListeners('close'); try { sat.destroy(); } catch { /* gone */ } }
    this._satellites.clear();
    for (const t of tabs) { try { t.view.destroyDtHost(); } catch { /* gone */ } }
  }

  /* ── Shared helpers ────────────────────────────────────────────────────────── */

  /** Remove a child from the window's contentView if attached; swallow the "not a child" throw. */
  _removeChild(view) {
    try { this._win.contentView.removeChildView(view); } catch { /* not attached */ }
  }

  /** Pull the active docked host out of the window if it belongs to `view`. */
  _detachHost(view) {
    if (this._dockedHost && this._dockedHost === view.devtoolsView) {
      this._removeChild(this._dockedHost);
      this._dockedHost = null;
    }
  }
}

module.exports = DevtoolsDock;
