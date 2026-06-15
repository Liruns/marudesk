import { describe, expect, it } from 'vitest';
import { freeTaskSlot } from './store';

const NODE = { w: 208, h: 118 };

function overlaps(a: { x: number; y: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x < b.x + b.w && a.x + NODE.w > b.x && a.y < b.y + b.h && a.y + NODE.h > b.y;
}

describe('freeTaskSlot', () => {
  it('returns the anchor unchanged when nothing is occupied', () => {
    expect(freeTaskSlot({ x: 500, y: 80 }, [])).toEqual({ x: 500, y: 80 });
  });

  it('keeps the x and nudges down past an occupying tab card', () => {
    const occupied = [{ x: 480, y: 60, w: 640, h: 460 }];
    const slot = freeTaskSlot({ x: 500, y: 80 }, occupied);
    expect(slot.x).toBe(500);
    expect(occupied.some((o) => overlaps(slot, o))).toBe(false);
    expect(slot.y).toBeGreaterThan(80);
  });

  it('stacks below earlier task nodes at the same anchor', () => {
    const occupied = [
      { x: 500, y: 80, w: NODE.w, h: NODE.h },
      { x: 500, y: 80 + NODE.h + 56, w: NODE.w, h: NODE.h },
    ];
    const slot = freeTaskSlot({ x: 500, y: 80 }, occupied);
    expect(slot.x).toBe(500);
    expect(occupied.every((o) => !overlaps(slot, o))).toBe(true);
  });
});
