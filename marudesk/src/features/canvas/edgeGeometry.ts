import type { CardRect, Edge, EdgeSide, EdgeStyle } from './store';

/**
 * Pure geometry for canvas edges — face anchors and path generation, shared by
 * the SVG layer (CanvasEdges) and the stage's delete-control overlay. Kept out of
 * the component file so it isn't re-evaluated on every Fast Refresh.
 */

export type Point = { x: number; y: number };

export function center(r: CardRect): Point {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/** Outward unit normal for a face. */
export function normal(side: EdgeSide): Point {
  switch (side) {
    case 'top':
      return { x: 0, y: -1 };
    case 'bottom':
      return { x: 0, y: 1 };
    case 'left':
      return { x: -1, y: 0 };
    case 'right':
      return { x: 1, y: 0 };
  }
}

/** Midpoint of a card's face. */
export function anchorOnSide(r: CardRect, side: EdgeSide): Point {
  switch (side) {
    case 'top':
      return { x: r.x + r.w / 2, y: r.y };
    case 'bottom':
      return { x: r.x + r.w / 2, y: r.y + r.h };
    case 'left':
      return { x: r.x, y: r.y + r.h / 2 };
    case 'right':
      return { x: r.x + r.w, y: r.y + r.h / 2 };
  }
}

/**
 * The face of `r` pointing toward `target` — aspect-aware so wide cards prefer
 * left/right and tall cards prefer top/bottom (matches the old center-ray feel).
 */
export function autoSide(r: CardRect, target: Point): EdgeSide {
  const c = center(r);
  const dx = target.x - c.x;
  const dy = target.y - c.y;
  if (Math.abs(dx) * r.h >= Math.abs(dy) * r.w) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
}

const isHoriz = (n: Point): boolean => n.x !== 0;

/** A cubic bezier leaving each face along its outward normal (node-editor flow). */
function curvePath(p1: Point, n1: Point, p2: Point, n2: Point | null): string {
  const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const k = Math.max(40, dist / 2);
  const c1 = { x: p1.x + n1.x * k, y: p1.y + n1.y * k };
  // A loose end (preview) has no face — arrive straight at the cursor.
  const c2 = n2 ? { x: p2.x + n2.x * k, y: p2.y + n2.y * k } : p2;
  return `M ${p1.x} ${p1.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p2.x} ${p2.y}`;
}

/** A right-angled route: a stub out of each face, then Manhattan segments. */
function orthoPath(p1: Point, n1: Point, p2: Point, n2: Point | null): string {
  const STUB = 28;
  const a1 = { x: p1.x + n1.x * STUB, y: p1.y + n1.y * STUB };
  const pts: Point[] = [p1, a1];
  if (!n2) {
    // Loose end: one corner from the stub toward the cursor.
    const corner = isHoriz(n1) ? { x: p2.x, y: a1.y } : { x: a1.x, y: p2.y };
    pts.push(corner, p2);
  } else {
    const a2 = { x: p2.x + n2.x * STUB, y: p2.y + n2.y * STUB };
    const h1 = isHoriz(n1);
    const h2 = isHoriz(n2);
    if (h1 && h2) {
      const mx = (a1.x + a2.x) / 2;
      pts.push({ x: mx, y: a1.y }, { x: mx, y: a2.y }, a2);
    } else if (!h1 && !h2) {
      const my = (a1.y + a2.y) / 2;
      pts.push({ x: a1.x, y: my }, { x: a2.x, y: my }, a2);
    } else if (h1 && !h2) {
      pts.push({ x: a2.x, y: a1.y }, a2);
    } else {
      pts.push({ x: a1.x, y: a2.y }, a2);
    }
    pts.push(p2);
  }
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
}

/** Build an edge's `d` path between two anchors (sides may be null for a loose end). */
export function pathFor(
  style: EdgeStyle,
  p1: Point,
  side1: EdgeSide,
  p2: Point,
  side2: EdgeSide | null,
): string {
  const n1 = normal(side1);
  const n2 = side2 ? normal(side2) : null;
  return style === 'orthogonal' ? orthoPath(p1, n1, p2, n2) : curvePath(p1, n1, p2, n2);
}

/** Resolve an edge's two face anchors and the sides they sit on, in canvas
 *  coords (sides auto-derived when unset). Shared by the SVG edge layer and the
 *  stage's delete-control overlay so both agree on the geometry. */
export function edgeEndpoints(
  a: CardRect,
  b: CardRect,
  edge: Edge,
): { p1: Point; p2: Point; fromSide: EdgeSide; toSide: EdgeSide } {
  const fromSide = edge.fromSide ?? autoSide(a, center(b));
  const toSide = edge.toSide ?? autoSide(b, center(a));
  return { p1: anchorOnSide(a, fromSide), p2: anchorOnSide(b, toSide), fromSide, toSide };
}

/**
 * The visual midpoint of an edge's path — where the delete control sits so it
 * lands ON the wire. The straight chord midpoint floats far off a curve that
 * bulges along its face normals (a top↔top wire arcs well above the chord), and
 * off the elbow of an orthogonal route; this follows the same control points as
 * {@link pathFor} so the control tracks the rendered path.
 */
export function edgeMidpoint(
  style: EdgeStyle,
  p1: Point,
  side1: EdgeSide,
  p2: Point,
  side2: EdgeSide,
): Point {
  const n1 = normal(side1);
  const n2 = normal(side2);
  if (style === 'orthogonal') {
    // Midpoint of the central span between the two face stubs (matches orthoPath).
    const STUB = 28;
    const a1 = { x: p1.x + n1.x * STUB, y: p1.y + n1.y * STUB };
    const a2 = { x: p2.x + n2.x * STUB, y: p2.y + n2.y * STUB };
    return { x: (a1.x + a2.x) / 2, y: (a1.y + a2.y) / 2 };
  }
  // Cubic bezier at t=0.5 with the same control points curvePath uses:
  // C(0.5) = (p1 + 3·c1 + 3·c2 + p2) / 8.
  const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const k = Math.max(40, dist / 2);
  const c1 = { x: p1.x + n1.x * k, y: p1.y + n1.y * k };
  const c2 = { x: p2.x + n2.x * k, y: p2.y + n2.y * k };
  return {
    x: (p1.x + 3 * c1.x + 3 * c2.x + p2.x) / 8,
    y: (p1.y + 3 * c1.y + 3 * c2.y + p2.y) / 8,
  };
}

/** The face nearest an interior point — pins a dropped edge end to where aimed. */
export function nearestSide(r: CardRect, pt: Point): EdgeSide {
  const d: Record<EdgeSide, number> = {
    top: pt.y - r.y,
    bottom: r.y + r.h - pt.y,
    left: pt.x - r.x,
    right: r.x + r.w - pt.x,
  };
  return (Object.keys(d) as EdgeSide[]).reduce((best, s) => (d[s] < d[best] ? s : best), 'right');
}
