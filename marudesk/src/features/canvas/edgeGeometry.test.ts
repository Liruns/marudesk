import { describe, expect, it } from 'vitest';
import { anchorOnSide, edgeMidpoint, type Point } from './edgeGeometry';
import type { CardRect } from './store';

const card = (x: number, y: number, w = 200, h = 120): CardRect => ({ x, y, w, h, z: 1 });
const chordMid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

describe('edgeMidpoint', () => {
  it('a curved top↔top wire bows ABOVE both anchors (off the chord)', () => {
    // Two cards side by side; connect top→top. The bezier arcs up, so its
    // midpoint sits well above the two top anchors and the straight chord.
    const a = card(0, 200);
    const b = card(400, 200);
    const p1 = anchorOnSide(a, 'top'); // (100, 200)
    const p2 = anchorOnSide(b, 'top'); // (500, 200)
    const mid = edgeMidpoint('curve', p1, 'top', p2, 'top');
    // Horizontally centred between the anchors…
    expect(Math.abs(mid.x - (p1.x + p2.x) / 2)).toBeLessThan(1e-6);
    // …but clearly above them (smaller y), unlike the chord midpoint which is level.
    expect(mid.y).toBeLessThan(p1.y - 40);
    expect(mid.y).toBeLessThan(chordMid(p1, p2).y - 40);
  });

  it('a curved right→left wire (no vertical offset) keeps the midpoint on the chord', () => {
    const a = card(0, 0);
    const b = card(400, 0);
    const p1 = anchorOnSide(a, 'right'); // (200, 60)
    const p2 = anchorOnSide(b, 'left'); // (400, 60)
    const mid = edgeMidpoint('curve', p1, 'right', p2, 'left');
    // Normals are +x / -x and cancel vertically, so y stays at the anchor line.
    expect(Math.abs(mid.y - p1.y)).toBeLessThan(1e-6);
    expect(mid.x).toBeGreaterThan(p1.x);
    expect(mid.x).toBeLessThan(p2.x);
  });

  it('an orthogonal wire midpoint sits between the two face stubs', () => {
    const a = card(0, 200);
    const b = card(400, 200);
    const p1 = anchorOnSide(a, 'top');
    const p2 = anchorOnSide(b, 'top');
    const mid = edgeMidpoint('orthogonal', p1, 'top', p2, 'top');
    // Stubs leave each top face by 28px upward; the central span midpoint is
    // centred horizontally and one stub-length above the anchors.
    expect(Math.abs(mid.x - (p1.x + p2.x) / 2)).toBeLessThan(1e-6);
    expect(Math.abs(mid.y - (p1.y - 28))).toBeLessThan(1e-6);
  });
});
