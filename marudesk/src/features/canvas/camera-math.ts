/**
 * Pure canvas geometry + easing, ported from the `pane` browser's tested canvas
 * math (reference/pane/src/main/canvas/{easing,camera,arrange}.js — see
 * reference/pane-porting-map.md §D). marudesk's camera convention already
 * matches pane's (screen = world·scale + pan), so these slot straight into the
 * canvas store's { panX, panY, scale } viewport. Side-effect-free, so they're
 * unit-tested without React (camera-math.test.ts).
 */

/** A canvas-space rect in the store's card convention. */
export type Rect = {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
};

/** A camera pose — structurally the store's Viewport. */
export type Pose = { panX: number; panY: number; scale: number };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Smooth two-way ease for camera commands (no overshoot). f(0)=0, f(1)=1. */
export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Spring-ish ease with a slight overshoot past 1 before settling — the "bounce"
 * for a flung card coming to rest (pane DESIGN §15 gesture motion). f(0)=0,
 * f(1)=1, and f rises above 1 near the end. Reserved for future fling gestures.
 */
export function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

/** Linearly interpolate a camera pose's pan + scale by k∈[0,1] (pair with an ease). */
export function lerpViewport(from: Pose, to: Pose, k: number): Pose {
  return {
    panX: from.panX + (to.panX - from.panX) * k,
    panY: from.panY + (to.panY - from.panY) * k,
    scale: from.scale + (to.scale - from.scale) * k,
  };
}

export type FitOptions = {
  /** Screen-px margin kept around the content box. */
  padding?: number;
  /** Extra top headroom (px) so card title bars aren't clipped. */
  titleH?: number;
  minScale?: number;
  maxScale?: number;
};

/**
 * The camera pose { panX, panY, scale } that fits every `rect` into `viewport`
 * ({ width, height } in screen px), centered, with `padding` margin and `titleH`
 * top headroom. Empty input → identity. Scale clamped to [minScale, maxScale].
 * Ported from pane's camera.fitPose (reference/pane/src/main/canvas/camera.js).
 */
export function fitPose(
  rects: readonly Rect[],
  viewport: { width: number; height: number },
  opts: FitOptions = {},
): Pose {
  const minScale = opts.minScale ?? 0.25;
  const maxScale = opts.maxScale ?? 2.5;
  if (rects.length === 0) return { panX: 0, panY: 0, scale: 1 };
  const padding = opts.padding ?? 60;
  const titleH = opts.titleH ?? 0;
  const minX = Math.min(...rects.map((r) => r.x));
  const minY = Math.min(...rects.map((r) => r.y));
  const maxX = Math.max(...rects.map((r) => r.x + r.w));
  const maxY = Math.max(...rects.map((r) => r.y + r.h));
  const bw = Math.max(1, maxX - minX);
  const bh = Math.max(1, maxY - minY);
  const availW = Math.max(1, viewport.width - 2 * padding);
  const availH = Math.max(1, viewport.height - 2 * padding - titleH);
  const scale = clamp(Math.min(availW / bw, availH / bh), minScale, maxScale);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return {
    panX: viewport.width / 2 - cx * scale,
    // Center, nudged down by half the title headroom so titles aren't clipped.
    panY: viewport.height / 2 - cy * scale + titleH / 2,
    scale,
  };
}

export type SlotOptions = {
  width?: number;
  height?: number;
  gap?: number;
  columns?: number;
};

/**
 * Grid auto-placement: the canvas rect for the card at 0-based `index`, filling
 * a row left-to-right before wrapping. Seeds initial positions so fresh cards
 * don't stack on one spot. Ported from pane's arrange.slotRect.
 */
export function slotRect(index: number, opts: SlotOptions = {}): Rect {
  const width = opts.width ?? 360;
  const height = opts.height ?? 240;
  const gap = opts.gap ?? 24;
  const columns = opts.columns ?? 3;
  const col = index % columns;
  const row = Math.floor(index / columns);
  return { x: col * (width + gap), y: row * (height + gap), w: width, h: height };
}
