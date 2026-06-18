'use strict';
const { CANVAS } = require('../../shared/config');

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/**
 * The infinite-canvas camera (CANVAS.md §3–4) — the single source of truth for the world↔screen
 * transform that both the DOM CanvasView and the main-process pane tiling (CanvasLayout) read.
 *
 * Coordinates are **region-local**: screen (0,0) is the top-left of the content region the window
 * hands the layout (right of the vertical-tabs rail, below the chrome). CanvasLayout adds the
 * region's (left, top) offset; the camera stays pure so it's unit-testable with no Electron.
 *
 * Transform: screen = world * scale + pan. `x`/`y` are the pan offset in region-local screen px,
 * `scale` the zoom factor (clamped to the usable band, CANVAS.MIN_SCALE..MAX_SCALE).
 */
class Camera {
  constructor({ x = 0, y = 0, scale = 1 } = {}) {
    this.x = x;
    this.y = y;
    this.scale = clamp(scale, CANVAS.MIN_SCALE, CANVAS.MAX_SCALE);
  }

  /** World point → region-local screen point. */
  worldToScreen(wx, wy) {
    return { x: wx * this.scale + this.x, y: wy * this.scale + this.y };
  }

  /** Region-local screen point → world point. */
  screenToWorld(sx, sy) {
    return { x: (sx - this.x) / this.scale, y: (sy - this.y) / this.scale };
  }

  /** World rect ({x,y,width,height}) → region-local screen rect (floats — round at setBounds). */
  worldRectToScreen(r) {
    const p = this.worldToScreen(r.x, r.y);
    return { x: p.x, y: p.y, width: r.width * this.scale, height: r.height * this.scale };
  }

  /** Pan by a region-local screen delta (drag the empty canvas). */
  panBy(dx, dy) {
    this.x += dx;
    this.y += dy;
    return this;
  }

  /** Set the absolute zoom, keeping the world point under screen anchor (ax,ay) fixed (pinch/wheel).
   *  Clamps to the usable band; when clamped, the anchor still stays put for the scale we land on. */
  zoomTo(scale, ax = 0, ay = 0) {
    const next = clamp(scale, CANVAS.MIN_SCALE, CANVAS.MAX_SCALE);
    const w = this.screenToWorld(ax, ay); // the world point we want to keep under the cursor
    this.scale = next;
    this.x = ax - w.x * next;
    this.y = ay - w.y * next;
    return this;
  }

  /** Multiply the zoom by `factor` about a screen anchor. */
  zoomBy(factor, ax = 0, ay = 0) {
    return this.zoomTo(this.scale * factor, ax, ay);
  }

  /** Jump straight to a target pose (used at the end of / without a tween). Scale is clamped. */
  set(pose) {
    if (!pose) return this;
    if (typeof pose.x === 'number') this.x = pose.x;
    if (typeof pose.y === 'number') this.y = pose.y;
    if (typeof pose.scale === 'number') this.scale = clamp(pose.scale, CANVAS.MIN_SCALE, CANVAS.MAX_SCALE);
    return this;
  }

  /** Serialize for the session (CANVAS.md persistence). */
  toJSON() { return { x: this.x, y: this.y, scale: this.scale }; }
}

/**
 * The camera pose ({x,y,scale}) that fits every world rect into `viewport` ({width,height} in
 * region-local px), centered, with `padding` margin and `titleH` headroom at the top for the panes'
 * title bars. Pure — unit-tested, no Electron — so the fit/reset/focus commands share one contract.
 * Empty input → identity. Scale is clamped to the usable band.
 */
function fitPose(rects, viewport, opts = {}) {
  if (!rects || !rects.length) return { x: 0, y: 0, scale: 1 };
  const padding = opts.padding ?? 60;
  const titleH = opts.titleH ?? 28;
  const minX = Math.min(...rects.map((r) => r.x));
  const minY = Math.min(...rects.map((r) => r.y));
  const maxX = Math.max(...rects.map((r) => r.x + r.width));
  const maxY = Math.max(...rects.map((r) => r.y + r.height));
  const bw = Math.max(1, maxX - minX);
  const bh = Math.max(1, maxY - minY);
  const availW = Math.max(1, viewport.width - 2 * padding);
  const availH = Math.max(1, viewport.height - 2 * padding - titleH);
  const scale = clamp(Math.min(availW / bw, availH / bh), CANVAS.MIN_SCALE, CANVAS.MAX_SCALE);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return {
    x: viewport.width / 2 - cx * scale,
    // Center vertically, nudged down by half the title headroom so title bars aren't clipped at the top.
    y: viewport.height / 2 - cy * scale + titleH / 2,
    scale,
  };
}

module.exports = Camera;
module.exports.fitPose = fitPose;
