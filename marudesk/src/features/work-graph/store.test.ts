import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __flushWorkGraphPersist,
  __workGraphPersistStats,
  freeTaskSlot,
  sampleGraph,
  useWorkGraphStore,
  WORKGRAPH_PERSIST_DEBOUNCE_MS,
} from './store';

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

describe('work-graph persistence', () => {
  it('does not re-strip the graph when only a node position changes', () => {
    const graph = sampleGraph('persist test');
    useWorkGraphStore.getState().setGraph(graph);
    // Prime the cache for the current graph identity.
    __flushWorkGraphPersist();
    const baseline = __workGraphPersistStats.graphSerializations;

    const id = useWorkGraphStore.getState().graph?.tasks[0]?.id;
    expect(id).toBeTruthy();
    if (!id) return;

    // A continuous "drag": pos-only mutations, graph identity unchanged.
    for (let i = 0; i < 5; i += 1) {
      useWorkGraphStore.getState().setPos(id, 100 + i, 200 + i);
      __flushWorkGraphPersist();
    }

    // withoutEvidence must not have re-run for any pos-only change.
    expect(__workGraphPersistStats.graphSerializations).toBe(baseline);
    // But the position must still be persisted.
    expect(useWorkGraphStore.getState().pos[id]).toEqual({ x: 104, y: 204 });
  });

  describe('debounced write', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    });

    it('writes once after a burst of rapid changes', () => {
      const graph = sampleGraph('debounce test');
      useWorkGraphStore.getState().setGraph(graph);
      const id = useWorkGraphStore.getState().graph?.tasks[0]?.id;
      expect(id).toBeTruthy();
      if (!id) return;

      const setItem = vi.spyOn(Storage.prototype, 'setItem');

      // Rapid changes, each well within the debounce window.
      for (let i = 0; i < 6; i += 1) {
        useWorkGraphStore.getState().setPos(id, i, i);
        vi.advanceTimersByTime(WORKGRAPH_PERSIST_DEBOUNCE_MS - 50);
      }
      expect(setItem).not.toHaveBeenCalled();

      // Settle: the trailing edge fires exactly one write.
      vi.advanceTimersByTime(WORKGRAPH_PERSIST_DEBOUNCE_MS);
      expect(setItem).toHaveBeenCalledTimes(1);

      setItem.mockRestore();
    });
  });
});
