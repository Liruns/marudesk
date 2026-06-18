'use strict';
const { BaseWindow, shell, screen } = require('electron');
const { TABSTRIP_HEIGHT, CHROME_HEIGHT, WINDOW, COLORS, CANVAS } = require('../shared/config');
const CH = require('../shared/channels');
const ChromeView = require('./chrome-view');
const TabManager = require('./tab-manager');
const TabLayout = require('./tab-layout');
const Camera = require('./canvas/camera');
const CanvasLayout = require('./canvas/canvas-layout');
const Canvas = require('./canvas/canvas');
const arrange = require('./canvas/arrange');
const { resizeWorld } = require('./canvas/resize');
const { easeInOutCubic, easeOutBack } = require('./canvas/easing');
const DevtoolsDock = require('./devtools-dock');
const Sidebar = require('./sidebar');
const { handlePageKey } = require('./shortcuts');
const settings = require('./settings');
const session = require('./session');

// Canvas input hardening: a glitchy/compromised surface renderer must never poison the camera or a
// pane's world rect with NaN/Infinity — a non-finite value would break every world↔screen transform
// AND get written to the persisted session (a permanently broken restore). Guard at the boundary.
const FIN = Number.isFinite;
const CANVAS_EDGES = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);
const validWorld = (r) => !!r && FIN(r.x) && FIN(r.y) && FIN(r.width) && FIN(r.height) && r.width > 0 && r.height > 0;

/** Clamp saved window bounds onto a currently-connected display so a window restored from a
 *  now-disconnected monitor (or a changed layout) can't open fully off-screen. */
function clampToDisplay(b) {
  if (!b) return null;
  try {
    const area = screen.getDisplayMatching({
      x: b.x | 0, y: b.y | 0, width: b.width || WINDOW.width, height: b.height || WINDOW.height,
    }).workArea;
    const width = Math.min(b.width || WINDOW.width, area.width);
    const height = Math.min(b.height || WINDOW.height, area.height);
    const x = Math.min(Math.max(b.x ?? area.x, area.x), area.x + area.width - width);
    const y = Math.min(Math.max(b.y ?? area.y, area.y), area.y + area.height - height);
    return { x, y, width, height };
  } catch { return null; }
}

/**
 * One browser window: a BaseWindow hosting the toolbar (ChromeView) over the active
 * tab's page. Owns layout/resize, swaps the visible page on tab change, bridges
 * TabManager events → the toolbar, and persists/restores the session.
 */
class PaneWindow {
  constructor(restore = null) {
    const b = clampToDisplay((restore && restore.bounds) || null);
    this.win = new BaseWindow({
      width: (b && b.width) || WINDOW.width,
      height: (b && b.height) || WINDOW.height,
      x: b ? b.x : undefined,
      y: b ? b.y : undefined,
      minWidth: WINDOW.minWidth,
      minHeight: WINDOW.minHeight,
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: COLORS.surface, symbolColor: COLORS.symbol, height: TABSTRIP_HEIGHT },
      backgroundColor: COLORS.canvas,
      // NB: Mica (backgroundMaterial:'mica') is intentionally NOT set — it renders black with
      // titleBarOverlay and breaks on maximize (electron/electron issues 42393, 39959, 41824).
      // Native window buttons win per the brief, so the toolbar ships opaque. Revisit if fixed.
    });

    this.chrome = new ChromeView();
    this.tabs = new TabManager();
    this._activeView = null;       // the active/focused pane (drives the toolbar, dock, focus)
    this._mounted = new Set();      // PageViews currently added as child views (visible). Tabs mode
                                    // mounts just the active view; canvas mode mounts every pane (CANVAS.md).
    this._mode = 'tabs';            // 'tabs' | 'canvas' — which layout strategy is live (CANVAS.md)
    this._lastBounds = null;
    this._chromeHeight = CHROME_HEIGHT; // grows while an overlay is open; layout() honors it

    // Docked devtools (DESIGN §4) — placement / splitter / detach / persistence live in this
    // controller, injected with the few window capabilities it needs. The window keeps the layout
    // math (delegating the page region to dock.layoutInto) and the tab-event bridging.
    this.dock = new DevtoolsDock({
      win: this.win,
      getActiveView: () => this._activeView,
      relayout: () => { this._lastBounds = null; this.layout(); },
      sendState: (payload) => { if (!this.win.isDestroyed()) this.chrome.send(CH.DEVTOOLS_STATE, payload); },
      // The dock tiles within the region right of the vertical-tabs rail; getInset() is the rail's
      // current width so a splitter drag clamps against the same span layout() does (DESIGN §5).
      getInset: () => this.sidebar.width(),
    });

    // Vertical tabs (DESIGN §11) — a left rail hosting the tab list as a second WebContentsView,
    // tiled left of the page like the devtools dock. Off by default; restored on chrome load below.
    this.sidebar = new Sidebar({ win: this.win, refreshTabs: () => this.tabs.refresh() });
    this._verticalTabs = !!settings.get('verticalTabs');
    this._railBeforeCanvas = false; // remembers the tabs-mode rail preference while canvas forces it off

    // The content-region layout strategies (CANVAS.md). layout() does the window-level math and hands
    // the post-rail region to _layout.place(); _layout points at one strategy, so swapping it swaps
    // the mode and the window stays closed to the difference.
    //  • TabLayout   — fills the region with the active tab (deferring to the devtools dock).
    //  • CanvasLayout — tiles every pane from the shared Camera (zoom/pan).
    this._camera = new Camera();
    this._tabLayout = new TabLayout({ dock: this.dock, getActiveView: () => this._activeView });
    this._canvasLayout = new CanvasLayout({ camera: this._camera, getPanes: () => this._canvasPanes() });
    this._layout = this._tabLayout;

    // The canvas surface view (off until canvas mode). Owns only the WebContentsView lifecycle; the
    // Camera / world rects / gesture math live here in the window. onReady → push the first frame +
    // resend the (off-band) tile snapshots so the surface paints them.
    this._reduceMotion = false; // mirrored from the surface (CANVAS_PREFS); camera tween honors it
    this.canvas = new Canvas({ win: this.win, onReady: () => { this._pushCanvas(); this._pushSnapshots(); } });

    this.win.contentView.addChildView(this.chrome.view);
    this._connect();

    // Chrome-focus keyboard shortcuts via before-input-event — preventDefault here reliably
    // stops the input reaching the page, so Ctrl+Tab etc. don't trigger focus traversal.
    this.chrome.webContents.on('before-input-event', (e, input) => handlePageKey(this.tabs, e, input));

    this._restoreTabs(restore);
    if (restore && restore.maximized) this.win.maximize();

    // DESIGN §5: reposition synchronously on resize (don't gate behind renderer rAF).
    // 'will-resize' carries the size the window is BECOMING — lay out to that, not the stale current size.
    this.win.on('will-resize', (_e, bounds) => this.layout(bounds));
    this.win.on('resize', () => this.layout());
    this.win.on('resized', () => { this.layout(); this._saveSession(); });
    this.win.on('moved', () => this._saveSession());
    // Take any detached devtools windows + per-tab hosts down with the main window. The OS 'X' fires
    // 'closed' without routing through TabManager teardown, so the dock retires them explicitly.
    this.win.on('closed', () => { this._cancelTween(); this._cancelPaneTween(); this.dock.handleWindowClosed(this.tabs.tabs); this.sidebar.destroy(); this.canvas.destroy(); });

    // DESIGN §14: when the app loses focus the chrome goes inert (a subtle muted shift, matching
    // native Win11 inactive-window behavior). The renderer applies the visual; main just reports state.
    this.win.on('focus', () => this._sendActive(true));
    this.win.on('blur', () => this._sendActive(false));

    this.chrome.webContents.once('did-finish-load', () => {
      // Restore the rail (if persisted on) and tell the chrome which mode it's in, so the top strip
      // hides and the menu toggle reflects reality from the first paint.
      if (this._verticalTabs) this.setVerticalTabs(true);
      if (settings.get('canvasMode')) this.setCanvasMode(true); // restore canvas mode (CANVAS.md)
      this._sendLayoutState();
      this.tabs.refresh();
      this._sendActive(this.win.isFocused()); // sync initial inert state once the toolbar is listening
    });
  }

  /** Tell the chrome which layout modes are live (menu checks, body classes). */
  _sendLayoutState() {
    this.chrome.send(CH.LAYOUT_STATE, { verticalTabs: this.sidebar.enabled, canvasMode: this._mode === 'canvas' });
  }

  _restoreTabs(restore) {
    const urls = restore && Array.isArray(restore.tabs) && restore.tabs.length ? restore.tabs : null;
    if (urls) {
      urls.forEach((u) => this.tabs.newTab(u || undefined));
      const arr = this.tabs.tabs;
      const idx = Math.min(Math.max(0, restore.activeIndex | 0), arr.length - 1);
      if (arr[idx]) this.tabs.activate(arr[idx].id);
    } else {
      this.tabs.newTab(); // fresh start page
    }
    // Restore the canvas layout (per-tab world rects + camera) by index, so reopening keeps the
    // arrangement (CANVAS.md persistence). canvasMode itself comes from settings, applied on load.
    const canvas = restore && restore.canvas;
    if (canvas) {
      // Validate before applying — a corrupted/hand-edited session must not seed a NaN world rect or
      // camera pose that then breaks every transform (and re-persists itself).
      if (Array.isArray(canvas.worlds)) {
        this.tabs.tabs.forEach((t, i) => { if (validWorld(canvas.worlds[i])) t.world = canvas.worlds[i]; });
      }
      const c = canvas.camera;
      if (c && FIN(c.x) && FIN(c.y) && FIN(c.scale)) this._camera.set(c);
    }
  }

  serialize() {
    const tabs = this.tabs.tabs;
    return {
      tabs: tabs.map((t) => (/^https?:\/\//i.test(t.url) ? t.url : '')),
      activeIndex: Math.max(0, tabs.findIndex((t) => t.id === this.tabs.activeId)),
      // When maximized, persist the NORMAL bounds so un-maximize after restore returns a sane size.
      bounds: this.win.isMaximized() ? this.win.getNormalBounds() : this.win.getBounds(),
      maximized: this.win.isMaximized(),
      // Canvas arrangement: per-tab world rects (index-aligned with `tabs`) + the camera pose.
      canvas: { camera: this._camera.toJSON(), worlds: tabs.map((t) => t.world || null) },
    };
  }

  _saveSession() {
    if (this.win.isDestroyed() || !settings.get('restoreSession')) return;
    session.save(this.serialize());
  }

  _sendActive(active) {
    if (this.win.isDestroyed()) return;
    this.chrome.send(CH.WINDOW_ACTIVE, { active: !!active });
  }

  layout(targetBounds) {
    if (this.win.isDestroyed()) return; // a resize event can still fire mid-teardown
    // Prefer the target size from 'will-resize' (the size the window is becoming) over the stale
    // current content bounds, so the native view tracks the drag without a one-frame lag (DESIGN §5).
    const { width, height } = targetBounds || this.win.getContentBounds();
    if (this._lastBounds && this._lastBounds.width === width && this._lastBounds.height === height) return;
    this._lastBounds = { width, height };

    this.chrome.view.setBounds({ x: 0, y: 0, width, height: this._chromeHeight });
    if (!this._activeView) return;

    const top = CHROME_HEIGHT - 1; // 1px overlap hides the seam (DESIGN §5)
    const regionH = Math.max(0, height - top);
    // The vertical-tabs rail (when on) takes the region's left edge; the page region starts after it.
    const left = this.sidebar.layout({ top, regionH, width });
    const region = { left, top, width, regionH };
    if (this._mode === 'canvas') {
      // Reserve any docked devtools (the active pane's) at the window edge; the canvas surface + every
      // pane tile into the remaining sub-region (CANVAS.md). placeDockForCanvas positions the dock.
      const cregion = this.dock.placeDockForCanvas(region);
      this.canvas.layout(cregion);
      this._layout.place(cregion); // CanvasLayout tiles the panes within the canvas sub-region
      // layout() is the single canvas re-pusher, so a window resize (which calls layout but no gesture
      // handler) re-syncs the surface frames, not just pans/zooms.
      this._pushCanvas(cregion);
    } else {
      // Tabs mode: the active tab fills the region, deferring to the dock for page │ splitter │ host.
      this._layout.place(region);
    }
  }

  /** Grow/shrink the chrome view to host an overlay (suggestions / menu). The view is
   *  transparent below the toolbar, so the page shows through around the panel. */
  setChromeHeight(h) {
    if (this.win.isDestroyed()) return;
    this._chromeHeight = Math.max(CHROME_HEIGHT, Math.round(h)); // remember so a resize won't collapse an open overlay
    const { width } = this.win.getContentBounds();
    this.chrome.view.setBounds({ x: 0, y: 0, width, height: this._chromeHeight });
  }

  _setActiveView(view) {
    if (this._activeView === view) return;
    // Canvas mode: freeze the outgoing pane to a snapshot before it's unmounted, so it keeps showing
    // (as a frozen tile) once only the new active pane stays live (CANVAS.md §3/§5).
    if (this._mode === 'canvas' && this._activeView && this._activeView !== view) {
      this._captureSnapshot(this._activeView);
    }
    this._activeView = view;
    this._syncMountedViews(); // mount the set this mode shows (tabs / canvas: the active view only)
    if (view) {
      // The active view changed, so the new view must be (re)tiled even when the window size is
      // unchanged. dock.reconcile() only relayouts when the dock state itself changes (it early-outs
      // otherwise), so it can't be relied on to size the new view — invalidate the size-cache and
      // lay out explicitly. Order matters: nulling before reconcile lets a dock-driven relayout
      // reset _lastBounds so the trailing layout() no-ops instead of tiling twice.
      this._lastBounds = null;
      this.dock.reconcile(); // swap in this pane's devtools (docked at the window edge in both modes)
      this.layout();         // tile page │ (splitter │ devtools), or the live canvas + reserved dock pane
      // Keep keyboard focus on the visible tab — otherwise a tab switch orphans focus
      // and the next Ctrl+Tab (a before-input-event) lands on no webContents.
      if (!view.webContents.isDestroyed()) view.webContents.focus();
      // (layout() re-pushes the canvas frames, incl. which pane is now live)
      // Canvas mode: bring the newly-live pane into view. Every activation surface — command palette,
      // tab strip, sidebar — funnels through here, so framing once fixes them all (a pane must never
      // go live off-screen). Same fitPose the tile-click focus uses → one "go to pane" motion.
      this._frameActivePane(view);
    }
  }

  /** Canvas mode: tween the camera so the active pane fills the viewport (the tile-click focus
   *  motion). No-op outside canvas, with no view, or for a pane without a world yet (a fresh tab is
   *  worlded after activation — the camera then stays put until the user pans/fits, as before). */
  _frameActivePane(view) {
    if (this._mode !== 'canvas' || !view) return;
    const t = this.tabs.tabs.find((x) => x.view === view);
    if (!t || !t.world) return;
    const { width, regionH } = this._region();
    this._animateCamera(Camera.fitPose([t.world], { width, height: regionH }));
  }

  /** Recompute which page views are mounted (visible) for the current layout mode. Both modes mount
   *  exactly the active view: in tabs mode it fills the region; in canvas mode it's the one LIVE pane
   *  (with true setZoomFactor zoom) floating over the snapshot tiles the surface renders (CANVAS.md). */
  _syncMountedViews() {
    this._mountViews(this._activeView ? [this._activeView] : []);
    if (this._mode === 'canvas') this._restackCanvas();
  }

  /** Mount exactly `list` (PageViews) as child views below the chrome, diffing against what's already
   *  mounted — add the new, remove the gone. The window's single place a page view becomes visible. */
  _mountViews(list) {
    const next = new Set(list);
    for (const v of this._mounted) {
      if (!next.has(v)) { this.win.contentView.removeChildView(v.view); this._mounted.delete(v); }
    }
    for (const v of next) {
      if (!this._mounted.has(v)) { this.win.contentView.addChildView(v.view, 0); this._mounted.add(v); } // below the chrome in z-order
    }
  }

  /** Enforce canvas z-order (bottom → top): canvas surface · the one live pane · chrome. Only the
   *  active pane is a mounted native view (the rest are snapshot tiles drawn by the surface), so the
   *  stack stays simple — the surface receives every gesture except over the live pane, which owns
   *  its own input (you interact with the focused page directly). */
  _restackCanvas() {
    const cv = this.win.contentView;
    if (this.canvas.view) cv.addChildView(this.canvas.view, 0); // the surface sits beneath the live pane
    if (this._activeView) cv.addChildView(this._activeView.view); // the live pane over the surface
    cv.addChildView(this.chrome.view);                            // chrome always on top (overlays, WCO)
  }

  _connect() {
    const { tabs, chrome, win } = this;
    tabs.on('active-page', (view) => this._setActiveView(view));
    tabs.on('all-closed', () => this.win.close());
    tabs.on('loading', (loading) => chrome.send(CH.LOADING, { loading }));
    // Any change in the active tab's devtools (open/close/tab-switch) → re-fit the dock and
    // re-sync the toolbar's icon + dock indicator. The boolean is ignored; placement is the truth.
    tabs.on('devtools', () => this.dock.refresh());
    tabs.on('devtools-toggle', () => this.dock.toggle()); // Ctrl+Shift+I (page focus)
    tabs.on('inspect', (x, y) => this.dock.inspectElement(x, y)); // right-click → Inspect Element
    tabs.on('toggle-vertical-tabs', () => this.setVerticalTabs(!this.sidebar.enabled)); // Ctrl+Shift+E
    tabs.on('tab-closed', (view) => this.dock.teardown(view));
    tabs.on('nav-state', (state) => chrome.send(CH.NAV_STATE, state));
    tabs.on('load-error', (err) => chrome.send(CH.LOAD_ERROR, err));
    tabs.on('focus-address', () => chrome.send(CH.FOCUS_ADDRESS));
    tabs.on('open-find', () => chrome.send(CH.OPEN_FIND));
    // The command palette is a full-window modal: focus the chrome so its input gets keys, and hand
    // the renderer the content height so it can grow the chrome view to cover (and dim) the page.
    tabs.on('open-palette', () => {
      if (win.isDestroyed()) return;
      chrome.webContents.focus();
      chrome.send(CH.OPEN_PALETTE, { height: win.getContentBounds().height });
    });
    tabs.on('found', (r) => chrome.send(CH.FOUND_RESULT, r));
    tabs.on('toast', (m) => chrome.send(CH.TOAST, m));
    tabs.on('open-external', (url) => { if (/^https?:/i.test(url)) shell.openExternal(url); });
    tabs.on('tabs', (state) => {
      chrome.send(CH.TABS_STATE, state);
      this.sidebar.send(CH.TABS_STATE, state); // the rail mirrors the top strip (no-op until enabled)
      this._ensureWorlds();                    // a new pane needs a world rect before it can be tiled
      this._pushCanvas();                      // refresh canvas frames (title / favicon / loading)
      this._saveSession();
      if (win.isDestroyed()) return;
      const a = state.tabs.find((t) => t.id === state.activeId);
      win.setTitle(a && a.title && a.title !== 'New Tab' ? `${a.title} — Pane` : 'Pane');
    });
  }

  /* ── Docked devtools (DESIGN §4) ────────────────────────────────────────────
     All placement / splitter / detach / persistence lives in DevtoolsDock. The window keeps thin
     facades for the IPC + keyboard paths and delegates page-region tiling to dock.layoutInto(). */
  toggleDevtools() { this.dock.toggle(); }            // toolbar click / Ctrl+Shift+I
  setDevtoolsDock(side) { this.dock.setDock(side); }  // dock picker: 'right' | 'bottom' | 'detach'
  onSplitterDrag(x, y) { this.dock.onSplitterDrag(x, y); }
  onSplitterDragEnd() { this.dock.onSplitterDragEnd(); }

  /* ── Vertical tabs (DESIGN §11) ──────────────────────────────────────────────
     Toggle the left rail on/off: persist the choice, attach/detach the rail view, re-tile so the
     page region insets/un-insets, and tell the chrome renderer (it hides the top strip + checks the
     menu toggle off the LAYOUT_STATE push). Page-region math stays in layout(); the rail owns only
     its own bounds + inset width. */
  setVerticalTabs(on, persist = true) {
    if (this.win.isDestroyed()) return;
    on = !!on;
    this._verticalTabs = on;
    // Canvas mode force-toggles the rail transiently (persist=false) so the saved tabs-mode
    // preference survives — a user's own toggle persists, but canvas owning the region does not.
    if (persist) settings.set('verticalTabs', on);
    // If the rail being removed currently holds keyboard focus, re-home it to the page — otherwise
    // focus is orphaned on the detached view and the next before-input-event shortcut (Ctrl+Tab …)
    // lands on no webContents (mirrors the tab-switch focus guard in _setActiveView).
    const rehome = !on && this.sidebar.isFocused();
    this.sidebar.setEnabled(on);
    if (rehome && this._activeView && !this._activeView.webContents.isDestroyed()) {
      this._activeView.webContents.focus();
    }
    this._lastBounds = null; // region width changed — force a full re-tile
    this.layout();
    this._sendLayoutState();
  }

  /* ── Infinite canvas (DESIGN §11 / CANVAS.md) ────────────────────────────────
     Canvas mode tiles every pane on one zoom-/pan-able surface instead of swapping one active tab.
     The window owns the Camera, the per-tab world rects, and the gesture math; the Canvas controller
     owns only the surface view. Only the active pane stays a LIVE native view (with true setZoomFactor
     zoom); the rest are frozen snapshot tiles the surface renders — so just one renderer is live.
     Drag the canvas to pan, wheel to zoom, drag a pane's title bar to move it, click a tile to make it
     live. The rail is forced off in canvas mode (it would fight the surface for the region); docked
     devtools stays — dock.placeDockForCanvas() reserves it at the window edge and the panes tile into
     the remainder, so the active pane keeps its devtools either way. */
  setCanvasMode(on) {
    if (this.win.isDestroyed()) return;
    on = !!on;
    const mode = on ? 'canvas' : 'tabs';
    if (mode === this._mode) return;
    this._mode = mode;
    settings.set('canvasMode', on);
    if (on) {
      // Canvas owns the whole region (v1), so force the rail off — but remember the preference and
      // DON'T persist the force-off, so exiting restores it and a quit mid-canvas can't clobber it.
      this._railBeforeCanvas = this.sidebar.enabled;
      if (this.sidebar.enabled) this.setVerticalTabs(false, false);
      this._ensureWorlds({ grid: true }); // spread existing panes on a grid on entry
      this.canvas.setEnabled(true);
      this._layout = this._canvasLayout;
    } else {
      this._cancelTween();
      this._cancelPaneTween();
      this.canvas.setEnabled(false);
      this._layout = this._tabLayout;
      // Leaving canvas: undo the live pane's zoom and drop the (now-stale) tiles so tabs mode is clean.
      for (const t of this.tabs.tabs) {
        if (!t.view.webContents.isDestroyed()) { try { t.view.webContents.setZoomFactor(1); } catch { /* gone */ } }
        t.view._snapshot = null;
      }
      // Restore the rail to the pre-canvas preference (transient — the saved preference was never
      // clobbered, so this re-attaches the view without a redundant persist).
      if (this._railBeforeCanvas) this.setVerticalTabs(true, false);
    }
    this._syncMountedViews(); // mount the active view (canvas restacks the surface under it)
    this.dock.reconcile();    // re-tile the active pane's devtools for the new mode (edge-docked either way)
    this._lastBounds = null;  // mode changed the whole region — force a full re-tile
    this.layout();            // (canvas branch re-pushes the frames; tabs branch pushes nothing)
    this._sendLayoutState();
  }

  /** Give worldless panes a world rect. On canvas ENTER ({grid:true}) every pane is seeded on a grid
   *  (arrange.js) so they spread out; a pane created LATER drops near the current viewport center
   *  (lightly cascaded) so it lands in view, not off at the grid origin. No-op outside canvas mode. */
  _ensureWorlds(opts = {}) {
    if (this._mode !== 'canvas') return;
    const worldless = this.tabs.tabs.filter((t) => !t.world);
    if (!worldless.length) return;
    if (opts.grid) {
      this.tabs.tabs.forEach((t, i) => { if (!t.world) t.world = arrange.slotRect(i); });
      return;
    }
    const c = this._viewportCenterWorld();
    const { width: W, height: H } = CANVAS.DEFAULT_PANE;
    worldless.forEach((t, k) => {
      t.world = { x: c.x - W / 2 + k * 30, y: c.y - H / 2 + k * 30, width: W, height: H };
    });
  }

  /** The world point at the center of the current viewport (region) — where new panes land. */
  _viewportCenterWorld() {
    const { width, regionH } = this._region();
    return this._camera.screenToWorld(width / 2, regionH / 2);
  }

  /* ── Canvas camera commands (animated) ───────────────────────────────────────
     fit / reset / focus tween the camera with an ease curve (DESIGN §15 — chrome-ish commands use
     ease, not the gesture springs). Direct gestures (pan/zoom/move) cancel any in-flight tween. */
  fitCanvas() {
    if (this._mode !== 'canvas') return;
    const rects = this.tabs.tabs.filter((t) => t.world).map((t) => t.world);
    const { width, regionH } = this._region();
    this._animateCamera(Camera.fitPose(rects, { width, height: regionH }));
  }
  resetCanvas() {
    if (this._mode !== 'canvas') return;
    const { width, regionH } = this._region();
    const act = this.tabs.tabs.find((t) => t.id === this.tabs.activeId);
    if (act && act.world) {
      const cx = act.world.x + act.world.width / 2;
      const cy = act.world.y + act.world.height / 2;
      this._animateCamera({ x: width / 2 - cx, y: regionH / 2 - cy, scale: 1 });
    } else {
      this._animateCamera({ x: 0, y: 0, scale: 1 });
    }
  }
  focusCanvasPane(id) {
    if (this._mode !== 'canvas') return;
    const t = this.tabs.tabs.find((x) => x.id === id);
    if (!t || !t.world) return;
    this.tabs.activate(id);      // raise + go live (frames the pane via _setActiveView if it changed)
    this._frameActivePane(t.view); // re-frame explicitly so clicking the ALREADY-active tile recenters too
  }

  /** Tween the camera from its current pose to `target` over `ms` (easeInOutCubic), re-tiling +
   *  re-pushing each frame. Outside canvas mode (or mid-teardown) it jumps. One tween at a time. */
  _animateCamera(target, ms = 320) {
    this._cancelTween();
    // Jump (no tween) when reduced motion is requested (DESIGN §15.5), mid-teardown, or not in canvas.
    if (this._reduceMotion || this.win.isDestroyed() || this._mode !== 'canvas') {
      this._camera.set(target); this._canvasRelayout(); return;
    }
    const from = { x: this._camera.x, y: this._camera.y, scale: this._camera.scale };
    const start = Date.now();
    const ease = easeInOutCubic;
    this._tween = setInterval(() => {
      if (this.win.isDestroyed()) { this._cancelTween(); return; }
      const p = Math.min(1, (Date.now() - start) / ms);
      const k = ease(p);
      this._camera.set({
        x: from.x + (target.x - from.x) * k,
        y: from.y + (target.y - from.y) * k,
        scale: from.scale + (target.scale - from.scale) * k,
      });
      this._canvasRelayout();
      if (p >= 1) this._cancelTween();
    }, 16);
  }
  _cancelTween() { if (this._tween) { clearInterval(this._tween); this._tween = null; } }

  /** The canvas content region (right of the rail, below the chrome, minus any docked devtools) in
   *  window coords. Pure (canvasRegionOf has no side effects), so gesture/push paths can read it
   *  without moving the dock. */
  _region() {
    const { width, height } = this.win.getContentBounds();
    const top = CHROME_HEIGHT - 1;
    const full = { left: this.sidebar.width(), top, width, regionH: Math.max(0, height - top) };
    return this.dock.canvasRegionOf(full);
  }

  /** The single live pane (the active one) adapted for CanvasLayout: its world rect + a setBounds
   *  that applies true zoom (setZoomFactor = camera scale) and tiles the native view. The other panes
   *  aren't mounted — they're frozen snapshots the surface renders — so only one renderer is ever
   *  live in canvas mode (the performance win, CANVAS.md §3). */
  _canvasPanes() {
    const scale = this._camera.scale;
    const tab = this.tabs.tabs.find((t) => t.id === this.tabs.activeId);
    if (!tab || !tab.world || tab.view.webContents.isDestroyed()) return [];
    return [{
      world: tab.world,
      setBounds: (r) => {
        try { tab.view.webContents.setZoomFactor(scale); } catch { /* destroyed mid-layout */ }
        tab.view.view.setBounds(r);
      },
    }];
  }

  /** Push the canvas state to the surface renderer: the camera scale + every pane's region-local
   *  clamped screen rect, plus a frozen snapshot for the non-live panes (the active one is the live
   *  native view, so it sends no snapshot — the surface leaves a hole there). No-op outside canvas. */
  _pushCanvas(region = this._region()) {
    if (this._mode !== 'canvas') return;
    const { left, top } = region;
    const activeId = this.tabs.activeId;
    const panes = this.tabs.tabs.filter((t) => t.world).map((t) => {
      const abs = this._canvasLayout.screenRectFor(t.world, region); // absolute, clamped to the region
      const active = t.id === activeId;
      return {
        id: t.id,
        title: t.title || 'New Tab',
        favicon: t.favicon || '',
        active,
        loading: !!t.loading,
        // NB: the snapshot bitmap is NOT in this per-frame payload — it ships on CANVAS_SNAPSHOT only
        // when it changes, so a 60fps pan/zoom doesn't re-serialize tens of KB of base64 per pane.
        screen: { x: abs.x - left, y: abs.y - top, width: abs.width, height: abs.height }, // region-local
        world: { x: t.world.x, y: t.world.y, width: t.world.width, height: t.world.height }, // for the minimap
      };
    });
    this.canvas.send(CH.CANVAS_STATE, {
      on: true,
      scale: this._camera.scale,
      camera: { x: this._camera.x, y: this._camera.y, scale: this._camera.scale }, // dot-grid pan + minimap viewport
      region: { width: region.width - left, height: region.regionH }, // region-local viewport size (minimap)
      panes,
    });
  }

  /** Freeze a pane to a snapshot (a downscaled data URL) so it keeps showing as a tile once it's no
   *  longer the live pane. Captured at zoom 1 so the surface can scale it like a thumbnail; best-effort
   *  (a never-painted background pane may capture blank → the surface falls back to a titled frame). */
  _captureSnapshot(pageView) {
    const wc = pageView.webContents;
    if (!wc || wc.isDestroyed()) return;
    try { wc.setZoomFactor(1); } catch { /* destroyed */ }
    wc.capturePage().then((img) => {
      if (wc.isDestroyed() || img.isEmpty()) return;
      const max = 640; // cap the tile bitmap — a handful of panes shouldn't carry full-res PNGs
      const { width } = img.getSize();
      const scaled = width > max ? img.resize({ width: max }) : img;
      pageView._snapshot = scaled.toDataURL();
      const tab = this.tabs.tabs.find((t) => t.view === pageView);
      if (tab) this.canvas.send(CH.CANVAS_SNAPSHOT, { id: tab.id, snapshot: pageView._snapshot }); // off the per-frame path
    }).catch(() => { /* capture can fail on an unmounted/navigating view — keep the last tile */ });
  }

  /** Resend every known tile bitmap on its own channel — used when the surface (re)loads, since the
   *  snapshots aren't part of the per-frame CANVAS_STATE. */
  _pushSnapshots() {
    if (this._mode !== 'canvas') return;
    for (const t of this.tabs.tabs) {
      if (t.view._snapshot) this.canvas.send(CH.CANVAS_SNAPSHOT, { id: t.id, snapshot: t.view._snapshot });
    }
  }

  /** Surface prefs from the renderer (reduced motion) — the camera tween jumps instead of animating. */
  setCanvasPrefs(prefs) { this._reduceMotion = !!(prefs && prefs.reduceMotion); }

  /** Re-tile the page views after a camera/world change. layout() re-pushes the frames. */
  _canvasRelayout() {
    this._lastBounds = null; // camera moves don't change window size — bypass the size cache
    this.layout();
  }

  /* Gesture handlers (canvas → main, forwarded by ipc.js). All no-op outside canvas mode; a direct
     gesture cancels any in-flight camera tween so the user's input wins immediately. */
  onCanvasPan(dx, dy) {
    if (this._mode !== 'canvas' || !FIN(dx) || !FIN(dy)) return;
    this._cancelTween();
    this._camera.panBy(dx, dy);
    this._canvasRelayout();
  }
  onCanvasZoom(factor, ax, ay) {
    if (this._mode !== 'canvas' || !FIN(factor) || factor <= 0 || !FIN(ax) || !FIN(ay)) return;
    this._cancelTween();
    this._camera.zoomBy(factor, ax, ay);
    this._canvasRelayout();
  }
  onCanvasPaneMove(id, dx, dy) {
    if (this._mode !== 'canvas' || !FIN(dx) || !FIN(dy)) return;
    this._cancelTween();
    this._cancelPaneTween(); // a fresh grab cancels a pane still settling from a previous fling
    const t = this.tabs.tabs.find((x) => x.id === id);
    if (!t || !t.world) return;
    // The drag delta is in screen px; divide by scale to move the pane the same distance in world space.
    t.world.x += dx / this._camera.scale;
    t.world.y += dy / this._camera.scale;
    this._canvasRelayout();
  }
  onCanvasPaneResize(id, edge, dx, dy) {
    if (this._mode !== 'canvas' || !CANVAS_EDGES.has(edge) || !FIN(dx) || !FIN(dy)) return;
    this._cancelTween();
    this._cancelPaneTween();
    const t = this.tabs.tabs.find((x) => x.id === id);
    if (!t || !t.world) return;
    const s = this._camera.scale; // screen delta → world delta
    t.world = resizeWorld(t.world, edge, dx / s, dy / s, CANVAS.MIN_PANE);
    this._canvasRelayout();
  }
  /** Release velocity of a pane drag (screen px/ms) → glide on with a spring overshoot to rest
   *  (DESIGN §15 gesture motion). Skipped under reduced motion or below a flick threshold. */
  onCanvasPaneFling(id, vx, vy) {
    if (this._mode !== 'canvas' || this._reduceMotion || !FIN(vx) || !FIN(vy)) return;
    if (Math.hypot(vx, vy) < 0.05) return; // too slow to be a throw
    const t = this.tabs.tabs.find((x) => x.id === id);
    if (!t || !t.world) return;
    const s = this._camera.scale;
    const PROJECT = 140; // how far the throw carries (ms-equivalent), in world units after ÷scale
    this._animatePaneWorld(t, t.world.x + (vx / s) * PROJECT, t.world.y + (vy / s) * PROJECT, 420);
  }

  /** Spring-settle a pane's world position to (tx,ty) over `ms` (easeOutBack overshoot), re-tiling
   *  each frame. One pane tween at a time; cancelled by a new grab/resize or leaving canvas. */
  _animatePaneWorld(tab, tx, ty, ms) {
    this._cancelPaneTween();
    const from = { x: tab.world.x, y: tab.world.y };
    const start = Date.now();
    this._paneTween = setInterval(() => {
      if (this.win.isDestroyed() || this._mode !== 'canvas') { this._cancelPaneTween(); return; }
      const p = Math.min(1, (Date.now() - start) / ms);
      const k = easeOutBack(p);
      tab.world.x = from.x + (tx - from.x) * k;
      tab.world.y = from.y + (ty - from.y) * k;
      this._canvasRelayout();
      if (p >= 1) this._cancelPaneTween();
    }, 16);
  }
  _cancelPaneTween() { if (this._paneTween) { clearInterval(this._paneTween); this._paneTween = null; } }
  /** Center the camera on a world point (the minimap click/drag-to-navigate), keeping zoom. */
  centerCanvasOn(wx, wy) {
    if (this._mode !== 'canvas' || !FIN(wx) || !FIN(wy)) return;
    this._cancelTween();
    const { left, width, regionH } = this._region();
    const s = this._camera.scale;
    this._camera.set({ x: (width - left) / 2 - wx * s, y: regionH / 2 - wy * s, scale: s });
    this._canvasRelayout();
  }
  raiseCanvasPane(id) {
    if (this._mode !== 'canvas') return;
    this.tabs.activate(id); // → active-page → _setActiveView restacks (pane to top) + refreshes frames
  }

  /** IPC trust boundary (defense-in-depth): only this window's own chrome (toolbar) and splitter
   *  views may drive the window.pane / splitter channels. Page/web views get the scoped
   *  `paneInternal` bridge (re-validated in internal-ipc) and no raw ipcRenderer, so they can't reach
   *  the chrome lane — but ipc.js validates every sender through here so the lane never trusts a
   *  stray view (a compromised/embedded frame, a future extra view) by default.
   *
   *  Per-sender routing: ipc.js resolves the window via `windows.fromSender(sender)` (which calls
   *  owns() below), so this gate validates against the *sender's own* window — the canvas/multi-window
   *  groundwork (DESIGN §11). With one window it resolves to that window; with several, a second
   *  window's legit chrome routes to — and is trusted by — its own window, not "the current" one. */
  isTrustedChromeSender(wc) {
    if (this.win.isDestroyed() || !wc) return false;
    if (wc === this.chrome.webContents) return true;
    // The vertical-tabs rail is privileged chrome (same preload as the toolbar) — it drives the
    // tab channels (activate/close/new/move), so it must be trusted alongside the chrome + splitter.
    if (this.sidebar.isSender(wc)) return true;
    // The canvas surface is privileged chrome too — it drives pan/zoom/move + tab channels (CANVAS.md).
    if (this.canvas.isSender(wc)) return true;
    return this.dock.isSplitterSender(wc);
  }

  /** Does `wc` belong to this window? Used by the registry (windows.fromSender) to route IPC to the
   *  sender's window — the multi-window / canvas story (DESIGN §11). Broader than
   *  isTrustedChromeSender, which gates the *trusted chrome lane* specifically: owns() also matches
   *  the page views (and their devtools hosts) so the internal-page lane (window.paneInternal) routes
   *  to the right window too. Routing ≠ trust — each lane still re-gates (chrome via
   *  isTrustedChromeSender, pages via internal-ipc's fromInternal). */
  owns(wc) {
    if (this.win.isDestroyed() || !wc) return false;
    if (this.isTrustedChromeSender(wc)) return true; // chrome + sidebar rail + devtools splitter
    for (const t of this.tabs.tabs) {
      if (t.view.webContents === wc) return true;          // a tab's page view
      const dt = t.view.devtoolsView;                      // …or its (lazy) devtools host
      if (dt && !dt.webContents.isDestroyed() && dt.webContents === wc) return true;
    }
    return false;
  }
}

module.exports = PaneWindow;
