'use strict';
// App-wide constants shared by main-process modules.
// (Renderer visual tokens live in renderer/styles/tokens.css — DESIGN.md is the spec for both.)
module.exports = {
  TABSTRIP_HEIGHT: 40,
  TOOLBAR_HEIGHT: 48,
  CHROME_HEIGHT: 88, // TABSTRIP_HEIGHT + TOOLBAR_HEIGHT
  DEFAULT_URL: 'https://example.com',
  WINDOW: { width: 1200, height: 800, minWidth: 640, minHeight: 480 },
  COLORS: {
    canvas: '#0a0a0b',   // window/page seam-hider
    surface: '#1d1d1f',  // toolbar fallback / WCO overlay tint
    symbol: '#f5f5f7',   // WCO caption-button glyphs
  },
  // Docked devtools (DESIGN §4 "runtime/devtools depth"). Sizes are the dock's extent on its
  // split axis (width for a right dock, height for a bottom dock); MIN_PAGE keeps the page usable.
  DEVTOOLS: {
    SPLITTER: 6,         // draggable gutter thickness (px)
    MIN: 250,            // smallest the devtools dock may shrink to
    MIN_PAGE: 150,       // smallest the page may shrink to beside/above the dock
    DEFAULT_RIGHT: 480,  // initial right-dock width
    DEFAULT_BOTTOM: 320, // initial bottom-dock height
  },
  // Vertical tabs (DESIGN §11 Arc/Zen lineage) — a left rail hosting the tab list as a second
  // WebContentsView, tiled left of the page like the devtools dock. Fixed width in v0; a draggable
  // splitter is the follow-up. MIN_PAGE keeps the rail from starving the page on narrow windows.
  SIDEBAR: {
    WIDTH: 240,    // left-rail width
    MIN_PAGE: 320, // never let the rail shrink the page below this
  },
  // Infinite canvas (DESIGN §11 / CANVAS.md) — the deferred zoom-/pan-able surface of many panes.
  // Scale band: a live pane's zoom factor is usable in a bounded range, so the camera clamps here.
  CANVAS: {
    MIN_SCALE: 0.1,  // furthest zoom-out
    MAX_SCALE: 4,    // closest zoom-in
    DEFAULT_PANE: { width: 800, height: 600 }, // a fresh pane's world size
    MIN_PANE: { width: 240, height: 180 },     // smallest a pane may be resized to (world units)
    PANE_GAP: 40,    // world-space gap when auto-arranging new panes
  },
};
