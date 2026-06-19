// Reserve the native window-controls (WCO) region at runtime (DESIGN §8), and
// double-click the title-bar area to maximize/restore (standard window behavior).
import { $, on } from '../lib/dom.js';

export function initWindowControls() {
  const root = document.documentElement;

  function applyWco() {
    const o = navigator.windowControlsOverlay;
    if (o && o.visible) {
      const r = o.getBoundingClientRect();
      const reservedRight = window.innerWidth - (r.x + r.width);
      root.style.setProperty('--wco-right', Math.max(0, reservedRight) + 'px');
    } else {
      root.style.setProperty('--wco-right', '0px'); // WCO hidden (e.g. fullscreen) — don't strand the reserved gap
    }
  }
  if (navigator.windowControlsOverlay) {
    navigator.windowControlsOverlay.addEventListener('geometrychange', applyWco);
    applyWco();
  }

  // throttle resize re-measure to one per frame (optimization)
  let raf = 0;
  window.addEventListener('resize', () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; applyWco(); });
  });

  // Double-click an empty part of the title-bar rows → toggle maximize.
  for (const id of ['#tabstrip', '#toolbar']) {
    const el = $(id);
    if (!el) continue;
    on(el, 'dblclick', (e) => {
      if (e.target.closest('.tab') || e.target.closest('.icon-btn') || e.target.closest('.address-pill')) return;
      window.pane.toggleMaximize();
    });
  }
}
