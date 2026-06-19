'use strict';
// Shared SVG glyphs for pane:// internal pages. Loaded as a CLASSIC script over pane://
// (a cross-host <script src> is not CORS-gated, unlike an ES module), so it just assigns
// window.PaneIcons before each page's own script runs. One source so the delete "X" never
// drifts across history / bookmarks / downloads.
// Glyphs are Lucide (lucide.dev, ISC) at its native 24×24 / stroke-2 / round geometry,
// matching the chrome's icon set (src/renderer/lib/icons.js) so a glyph never drifts.
window.PaneIcons = {
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/></svg>',
};
