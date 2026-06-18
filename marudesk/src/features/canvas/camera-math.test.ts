import { describe, expect, it } from 'vitest';
import {
  easeInOutCubic,
  easeOutBack,
  fitPose,
  lerpViewport,
  packGrid,
  slotRect,
  type Rect,
  type SizedCard,
} from './camera-math';

const near = (a: number, b: number, eps = 1e-9) =>
  expect(Math.abs(a - b) <= eps).toBe(true);

describe('easing', () => {
  it('easeInOutCubic pins endpoints and midpoint', () => {
    near(easeInOutCubic(0), 0);
    near(easeInOutCubic(1), 1);
    near(easeInOutCubic(0.5), 0.5);
  });

  it('easeInOutCubic is monotonic and bounded in [0,1]', () => {
    let prev = -1;
    for (let i = 0; i <= 20; i++) {
      const v = easeInOutCubic(i / 20);
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v).toBeGreaterThanOrEqual(-1e-9);
      expect(v).toBeLessThanOrEqual(1 + 1e-9);
      prev = v;
    }
  });

  it('easeOutBack pins endpoints and overshoots above 1', () => {
    near(easeOutBack(0), 0);
    near(easeOutBack(1), 1);
    let max = 0;
    for (let i = 0; i <= 100; i++) max = Math.max(max, easeOutBack(i / 100));
    expect(max).toBeGreaterThan(1);
  });
});

describe('lerpViewport', () => {
  it('interpolates pan and scale', () => {
    const from = { panX: 0, panY: 0, scale: 1 };
    const to = { panX: 100, panY: -50, scale: 2 };
    expect(lerpViewport(from, to, 0)).toEqual(from);
    expect(lerpViewport(from, to, 1)).toEqual(to);
    expect(lerpViewport(from, to, 0.5)).toEqual({ panX: 50, panY: -25, scale: 1.5 });
  });
});

describe('fitPose', () => {
  it('is identity for no rects', () => {
    expect(fitPose([], { width: 800, height: 600 })).toEqual({ panX: 0, panY: 0, scale: 1 });
  });

  it('centers a single rect and clamps to the max scale band', () => {
    const pose = fitPose([{ x: 0, y: 0, w: 100, h: 100 }], { width: 800, height: 600 }, {
      padding: 0,
      titleH: 0,
    });
    // min(800/100, 600/100) = 6 → clamped to default maxScale 2.5.
    expect(pose.scale).toBe(2.5);
    near(pose.panX, 800 / 2 - 50 * 2.5); // 275
    near(pose.panY, 600 / 2 - 50 * 2.5); // 175
  });

  it('scales down to fit a wide spread within padding', () => {
    const rects: Rect[] = [
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 1900, y: 0, w: 100, h: 100 },
    ];
    const pose = fitPose(rects, { width: 1000, height: 1000 }, { padding: 100, titleH: 0 });
    // bbox 2000 wide; avail 800 → 0.4.
    near(pose.scale, 0.4);
    near(pose.panX, 500 - 1000 * 0.4); // 100
  });

  it('never exceeds the scale band', () => {
    const tiny = fitPose([{ x: 0, y: 0, w: 1, h: 1 }], { width: 8000, height: 8000 });
    expect(tiny.scale).toBeLessThanOrEqual(2.5);
    const huge = fitPose([{ x: 0, y: 0, w: 100000, h: 100000 }], { width: 100, height: 100 });
    expect(huge.scale).toBeGreaterThanOrEqual(0.25);
  });
});

describe('slotRect', () => {
  const opts = { width: 100, height: 80, gap: 10, columns: 3 };

  it('fills across a row then wraps', () => {
    expect(slotRect(0, opts)).toEqual({ x: 0, y: 0, w: 100, h: 80 });
    expect(slotRect(2, opts)).toEqual({ x: 220, y: 0, w: 100, h: 80 });
    expect(slotRect(3, opts)).toEqual({ x: 0, y: 90, w: 100, h: 80 });
  });

  it('produces no overlaps among the first nine slots', () => {
    const rects = Array.from({ length: 9 }, (_, i) => slotRect(i, opts));
    const overlaps = (a: Rect, b: Rect) =>
      a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(overlaps(rects[i], rects[j])).toBe(false);
      }
    }
  });
});

describe('packGrid', () => {
  it('returns nothing for no cards', () => {
    expect(packGrid([])).toEqual({});
  });

  it('aligns mixed-size cards into a non-overlapping grid', () => {
    const cards: SizedCard[] = [
      { key: 'a', w: 200, h: 100 },
      { key: 'b', w: 300, h: 120 },
      { key: 'c', w: 150, h: 200 },
      { key: 'd', w: 220, h: 90 },
    ];
    const pos = packGrid(cards, { gap: 20, columns: 2, originX: 0, originY: 0 });
    // 2 columns → col widths [max(a,c)=200, max(b,d)=300]; row heights [max(a,b)=120, max(c,d)=200].
    expect(pos.a).toEqual({ x: 0, y: 0 });
    expect(pos.b).toEqual({ x: 220, y: 0 }); // 200 + gap 20
    expect(pos.c).toEqual({ x: 0, y: 140 }); // 120 + gap 20
    expect(pos.d).toEqual({ x: 220, y: 140 });

    // No two card rects overlap.
    const rects = cards.map((c) => ({ ...pos[c.key], w: c.w, h: c.h }));
    const overlaps = (
      a: { x: number; y: number; w: number; h: number },
      b: { x: number; y: number; w: number; h: number },
    ) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(overlaps(rects[i], rects[j])).toBe(false);
      }
    }
  });

  it('honors the origin offset', () => {
    const pos = packGrid([{ key: 'a', w: 100, h: 100 }], { originX: 50, originY: 70 });
    expect(pos.a).toEqual({ x: 50, y: 70 });
  });
});
