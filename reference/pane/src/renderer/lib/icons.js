// Shared SVG icon set for the chrome. 24×24 stroke icons; size and color come from CSS
// (currentColor + width/height on the host element). One source so a glyph never drifts.
// Glyphs are Lucide (lucide.dev, ISC) — vendored inline (no runtime dep) at Lucide's native
// 24×24 / stroke-2 / round-cap geometry, which is exactly this wrapper's format, so every glyph
// shares one stroke weight (no per-icon width tuning).
const svg = (inner, w = 2) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

export const ICONS = {
  close:       svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  globe:       svg('<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>'),
  reload:      svg('<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>'),
  chevronUp:   svg('<path d="m18 15-6-6-6 6"/>'),
  chevronDown: svg('<path d="m6 9 6 6 6-6"/>'),
  arrowRight:  svg('<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>'),
  search:      svg('<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>'),
  history:     svg('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>'),
  lock:        svg('<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
  unlock:      svg('<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>'),
  warning:     svg('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
  // Command-palette action glyphs (DESIGN §4 component grammar — 24×24 stroke, currentColor).
  plus:        svg('<path d="M5 12h14"/><path d="M12 5v14"/>'),
  reopen:      svg('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>'),
  code:        svg('<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>'),
  bookmark:    svg('<path d="M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z"/>'),
  download:    svg('<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>'),
  settings:    svg('<path d="M10 5H3"/><path d="M12 19H3"/><path d="M14 3v4"/><path d="M16 17v4"/><path d="M21 12h-9"/><path d="M21 19h-5"/><path d="M21 5h-7"/><path d="M8 10v4"/><path d="M8 12H3"/>'),
};
