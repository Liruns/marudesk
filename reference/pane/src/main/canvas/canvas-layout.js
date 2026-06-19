'use strict';

/**
 * Canvas-mode content layout (CANVAS.md §3–4) — the second layout strategy beside TabLayout.
 *
 * Where TabLayout fills the content region with one active tab, CanvasLayout tiles **many panes**
 * across the region from the shared Camera: each pane has a world rect, the camera maps it to a
 * region-local screen rect, and we `setBounds` the native view to the region-offset, integer-rounded
 * result (DESIGN §5: native views take integer pixel rects and reposition synchronously in main).
 *
 * A pane fully outside the region is collapsed to a zero-size rect (cheap "hidden") rather than
 * unmounted here — mount/unmount churn is the window's call. Phase 5 (CANVAS.md) layers frozen-tile
 * snapshots on top of this so off-screen / unfocused panes don't each burn a live renderer; this
 * strategy only owns the geometry.
 *
 * Same `.place(region)` shape as TabLayout, so PaneWindow swaps strategies without branching.
 */
class CanvasLayout {
  /**
   * @param {{ camera: import('./camera'),
   *           getPanes: () => Array<{ world: {x,y,width,height}, setBounds: (r) => void }> }} deps
   */
  constructor({ camera, getPanes }) {
    this._camera = camera;
    this._getPanes = getPanes;
  }

  /** Position every pane for the current camera within `region` ({ left, top, width, regionH }). */
  place(region) {
    for (const pane of this._getPanes()) {
      pane.setBounds(this.screenRectFor(pane.world, region));
    }
  }

  /**
   * The integer screen rect for a world rect within `region`, clamped to the region's bounds and
   * collapsed to zero size when there's no overlap. Pure (no side effects) so it's unit-testable and
   * reusable by the CanvasView for hit-testing / culling.
   */
  screenRectFor(world, region) {
    const { left, top, width, regionH } = region;
    const s = this._camera.worldRectToScreen(world);
    // Region-local → absolute window coords.
    let x0 = left + s.x;
    let y0 = top + s.y;
    let x1 = x0 + s.width;
    let y1 = y0 + s.height;
    // Clamp to the content region so a pane never spills over the chrome / rail.
    const rx0 = Math.max(x0, left);
    const ry0 = Math.max(y0, top);
    const rx1 = Math.min(x1, left + width);
    const ry1 = Math.min(y1, top + regionH);
    if (rx1 <= rx0 || ry1 <= ry0) return { x: left, y: top, width: 0, height: 0 }; // off-region → hidden
    return {
      x: Math.round(rx0),
      y: Math.round(ry0),
      width: Math.round(rx1 - rx0),
      height: Math.round(ry1 - ry0),
    };
  }
}

module.exports = CanvasLayout;
