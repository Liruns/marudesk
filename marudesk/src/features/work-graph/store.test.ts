import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunTaskResult } from '../../../shared/work-os';
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

describe('acceptance criteria editing', () => {
  it('adds a criterion immutably and leaves other tasks untouched', () => {
    const graph = sampleGraph('criteria add');
    useWorkGraphStore.getState().setGraph(graph);
    const tasks = useWorkGraphStore.getState().graph?.tasks ?? [];
    const target = tasks[0];
    const other = tasks[1];
    expect(target && other).toBeTruthy();
    if (!target || !other) return;

    const beforeTarget = target.acceptance;
    const beforeOtherRef = other.acceptance;

    useWorkGraphStore.getState().addCriterion(target.id, '  new acceptance  ');

    const after = useWorkGraphStore.getState().graph?.tasks ?? [];
    const afterTarget = after.find((t) => t.id === target.id);
    const afterOther = after.find((t) => t.id === other.id);
    expect(afterTarget?.acceptance.length).toBe(beforeTarget.length + 1);
    // Trimmed, fresh unknown verdict.
    const added = afterTarget?.acceptance.at(-1);
    expect(added?.text).toBe('new acceptance');
    expect(added?.verdict).toBe('unknown');
    // Immutable: original array not mutated; other task's array reference reused.
    expect(afterTarget?.acceptance).not.toBe(beforeTarget);
    expect(afterOther?.acceptance).toBe(beforeOtherRef);
  });

  it('ignores a blank criterion', () => {
    const graph = sampleGraph('criteria blank');
    useWorkGraphStore.getState().setGraph(graph);
    const target = useWorkGraphStore.getState().graph?.tasks[0];
    expect(target).toBeTruthy();
    if (!target) return;
    const before = target.acceptance.length;
    useWorkGraphStore.getState().addCriterion(target.id, '   ');
    const after = useWorkGraphStore.getState().graph?.tasks.find((t) => t.id === target.id);
    expect(after?.acceptance.length).toBe(before);
  });

  it('removes one criterion immutably and leaves other tasks untouched', () => {
    const graph = sampleGraph('criteria remove');
    useWorkGraphStore.getState().setGraph(graph);
    const tasks = useWorkGraphStore.getState().graph?.tasks ?? [];
    // Pick a task that has at least one criterion (sampleGraph fills several).
    const target = tasks.find((t) => t.acceptance.length > 0);
    const other = tasks.find((t) => t.id !== target?.id);
    expect(target && other).toBeTruthy();
    if (!target || !other) return;

    const removeId = target.acceptance[0]?.id;
    const beforeOtherRef = other.acceptance;
    expect(removeId).toBeTruthy();
    if (!removeId) return;

    useWorkGraphStore.getState().removeCriterion(target.id, removeId);

    const after = useWorkGraphStore.getState().graph?.tasks ?? [];
    const afterTarget = after.find((t) => t.id === target.id);
    const afterOther = after.find((t) => t.id === other.id);
    expect(afterTarget?.acceptance.some((c) => c.id === removeId)).toBe(false);
    expect(afterTarget?.acceptance.length).toBe(target.acceptance.length - 1);
    // Other task's criteria array is reused (not rebuilt).
    expect(afterOther?.acceptance).toBe(beforeOtherRef);
  });

  it('removeCriterion is a no-op for an unknown criterion id', () => {
    const graph = sampleGraph('criteria remove miss');
    useWorkGraphStore.getState().setGraph(graph);
    const target = useWorkGraphStore.getState().graph?.tasks.find((t) => t.acceptance.length > 0);
    expect(target).toBeTruthy();
    if (!target) return;
    const before = target.acceptance.length;
    useWorkGraphStore.getState().removeCriterion(target.id, 'does-not-exist');
    const after = useWorkGraphStore.getState().graph?.tasks.find((t) => t.id === target.id);
    expect(after?.acceptance.length).toBe(before);
  });
});

describe('runOne', () => {
  // Route workos:run-task to a per-test result; record which task ids were invoked
  // so we can prove runOne touches ONLY the one task.
  let result: RunTaskResult;
  let invokedTaskIds: string[];

  beforeEach(() => {
    invokedTaskIds = [];
    result = { ok: true, status: 'done', result: 'verified', outputs: [] };
    (globalThis as unknown as { window: { marudesk: unknown } }).window.marudesk = {
      invoke: async (channel: string, payload?: unknown) => {
        if (channel === 'workos:run-task') {
          invokedTaskIds.push((payload as { taskId: string }).taskId);
          return result;
        }
        return undefined;
      },
      on: () => () => {},
    };
  });

  it('stores evidence + status for ONLY the targeted task', async () => {
    const graph = sampleGraph('run one');
    useWorkGraphStore.getState().setGraph(graph);
    const tasks = useWorkGraphStore.getState().graph?.tasks ?? [];
    const target = tasks[0];
    const other = tasks[1];
    expect(target && other).toBeTruthy();
    if (!target || !other) return;

    await useWorkGraphStore.getState().runOne(target.id);

    // Exactly one invoke, for the target task.
    expect(invokedTaskIds).toEqual([target.id]);

    const after = useWorkGraphStore.getState().graph?.tasks ?? [];
    const afterTarget = after.find((t) => t.id === target.id);
    const afterOther = after.find((t) => t.id === other.id);
    expect(afterTarget?.status).toBe('done');
    expect(afterTarget?.evidence?.result).toBe('verified');
    // The other task is untouched (no evidence, still planned).
    expect(afterOther?.evidence).toBeUndefined();
    expect(afterOther?.status).toBe('planned');
    // The run flag is cleared once the single task settles.
    expect(useWorkGraphStore.getState().running).toBe(false);
  });

  it('is a no-op for an unknown task id', async () => {
    const graph = sampleGraph('run one unknown');
    useWorkGraphStore.getState().setGraph(graph);

    await useWorkGraphStore.getState().runOne('does-not-exist');

    expect(invokedTaskIds).toEqual([]);
    expect(useWorkGraphStore.getState().running).toBe(false);
  });

  it('is a no-op while a run is already in flight', async () => {
    const graph = sampleGraph('run one busy');
    useWorkGraphStore.getState().setGraph(graph);
    const target = useWorkGraphStore.getState().graph?.tasks[0];
    expect(target).toBeTruthy();
    if (!target) return;

    useWorkGraphStore.setState({ running: true });
    await useWorkGraphStore.getState().runOne(target.id);

    // Gated out: never invoked, and it must not clobber the in-flight run flag.
    expect(invokedTaskIds).toEqual([]);
    expect(useWorkGraphStore.getState().running).toBe(true);
    useWorkGraphStore.setState({ running: false });
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
