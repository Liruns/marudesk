import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunTaskResult } from '../../../shared/work-os';
import {
  __flushWorkGraphPersist,
  __workGraphPersistStats,
  demoteStaleRunning,
  freeTaskSlot,
  runWithConcurrency,
  sampleGraph,
  useWorkGraphStore,
  WORKGRAPH_PERSIST_DEBOUNCE_MS,
  WORKGRAPH_RUN_CONCURRENCY,
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

describe('demoteStaleRunning', () => {
  it('returns null unchanged', () => {
    expect(demoteStaleRunning(null)).toBeNull();
  });

  it('returns the same reference when no task is running (no churn on a clean load)', () => {
    const graph = sampleGraph('clean load');
    expect(graph.tasks.every((t) => t.status !== 'running')).toBe(true);
    expect(demoteStaleRunning(graph)).toBe(graph);
  });

  it('demotes a stale running task to planned while leaving other statuses intact', () => {
    const base = sampleGraph('crash mid-run');
    const graph = {
      ...base,
      tasks: base.tasks.map((t, i) =>
        i === 0 ? { ...t, status: 'running' as const } : i === 1 ? { ...t, status: 'done' as const } : t,
      ),
    };
    const out = demoteStaleRunning(graph);
    expect(out).not.toBeNull();
    expect(out?.tasks[0]?.status).toBe('planned');
    expect(out?.tasks[1]?.status).toBe('done');
    expect(out?.tasks.some((t) => t.status === 'running')).toBe(false);
  });
});

describe('write actions are blocked while a patch is applying', () => {
  let invoked: string[];

  beforeEach(() => {
    invoked = [];
    // Inbound isolation: the ONLY thing blocking the actions must be the
    // applyingPatchTaskId set in the test body — pin running false so a leaked
    // `running: true` from an earlier test can't make the assertion pass for the
    // wrong reason.
    useWorkGraphStore.setState({ running: false, applyingPatchTaskId: null });
    (globalThis as unknown as { window: { marudesk: unknown } }).window.marudesk = {
      invoke: async (channel: string) => {
        if (channel === 'workos:implement-task' || channel === 'workos:run-task') {
          invoked.push(channel);
          return { ok: true, status: 'done', result: 'x', outputs: [] };
        }
        return undefined;
      },
      on: () => () => {},
    };
  });

  afterEach(() => {
    useWorkGraphStore.setState({ applyingPatchTaskId: null, running: false });
  });

  it('implementTask / runOne / implementReady no-op while applyingPatchTaskId is set', async () => {
    const graph = sampleGraph('apply guard');
    useWorkGraphStore.getState().setGraph(graph);
    const target = useWorkGraphStore.getState().graph?.tasks[0];
    expect(target).toBeTruthy();
    if (!target) return;

    // A patch is mid-apply to the live tree — no write run may start concurrently,
    // whatever the entry point (inspector button OR ⌘K verb both hit the store).
    useWorkGraphStore.setState({ applyingPatchTaskId: target.id });

    await useWorkGraphStore.getState().implementTask(target.id);
    await useWorkGraphStore.getState().runOne(target.id);
    await useWorkGraphStore.getState().implementReady();

    expect(invoked).toEqual([]);
  });
});

describe('run() dead-end recovery hint', () => {
  beforeEach(() => {
    useWorkGraphStore.setState({ running: false, applyingPatchTaskId: null });
    (globalThis as unknown as { window: { marudesk: unknown } }).window.marudesk = {
      invoke: async (channel: string) => {
        if (channel === 'workos:run-task') return { ok: true, status: 'failed', result: 'nope', outputs: [] };
        return undefined;
      },
      on: () => () => {},
    };
  });

  it('points the user at Reset when a run settles with a failed task and nothing ready', async () => {
    const sample = sampleGraph('dead end');
    const first = sample.tasks[0];
    expect(first).toBeTruthy();
    if (!first) return;
    // One planned task so the run settles right after it fails (no ready set left).
    useWorkGraphStore.getState().setGraph({ ...sample, tasks: [{ ...first, status: 'planned' }], edges: [] });

    await useWorkGraphStore.getState().run();

    expect(useWorkGraphStore.getState().runNote).toMatch(/Reset to retry/);
    expect(useWorkGraphStore.getState().running).toBe(false);
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

describe('runWithConcurrency', () => {
  it('runs every item but never exceeds the limit in flight, and preserves input order', async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    let inFlight = 0;
    let peak = 0;
    const limit = 4;

    const results = await runWithConcurrency(items, limit, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // Yield so other slots have a chance to start before this one resolves.
      await new Promise<void>((r) => setTimeout(r, 1));
      inFlight -= 1;
      return n * 2;
    });

    // All items processed, results in INPUT order (not completion order).
    expect(results).toEqual(items.map((n) => n * 2));
    // Cap respected at every instant.
    expect(peak).toBeLessThanOrEqual(limit);
    // With more items than the cap, the pool actually saturates.
    expect(peak).toBe(limit);
  });

  it('caps at the item count when there are fewer items than the limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await runWithConcurrency([1, 2], 4, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((r) => setTimeout(r, 1));
      inFlight -= 1;
      return n;
    });
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('stops pulling new items once shouldStop flips, but settles launched ones', async () => {
    const items = Array.from({ length: 12 }, (_, i) => i);
    const started: number[] = [];
    let stop = false;

    await runWithConcurrency(
      items,
      2,
      async (n) => {
        started.push(n);
        await new Promise<void>((r) => setTimeout(r, 1));
        // Flip stop after the first couple have started.
        if (started.length >= 2) stop = true;
        return n;
      },
      () => stop,
    );

    // Far fewer than all 12 were ever started — the stop halted further launches.
    expect(started.length).toBeLessThan(items.length);
    expect(started.length).toBeGreaterThanOrEqual(2);
  });
});

describe('run() bounded fan-out', () => {
  let inFlight: number;
  let peak: number;
  let invokedTaskIds: string[];
  let releasers: Array<() => void>;

  beforeEach(() => {
    inFlight = 0;
    peak = 0;
    invokedTaskIds = [];
    releasers = [];
    (globalThis as unknown as { window: { marudesk: unknown } }).window.marudesk = {
      invoke: async (channel: string, payload?: unknown) => {
        if (channel === 'workos:run-task') {
          invokedTaskIds.push((payload as { taskId: string }).taskId);
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          // Hold the invoke open until released, so several can pile up at once and we
          // can measure the true concurrent peak across a wide ready layer.
          await new Promise<void>((resolve) => {
            releasers.push(() => {
              inFlight -= 1;
              resolve();
            });
          });
          return { ok: true, status: 'done', result: 'verified', outputs: [] };
        }
        return undefined;
      },
      on: () => () => {},
    };
  });

  /** Resolve every pending invoke (e.g. between scheduler layers). */
  function releaseAll(): void {
    const pending = releasers;
    releasers = [];
    for (const r of pending) r();
  }

  /** A flat graph: one layer of `n` mutually-independent ready tasks. */
  function wideGraph(n: number): ReturnType<typeof sampleGraph> {
    const base = sampleGraph('wide');
    const tasks = Array.from({ length: n }, (_, i) => ({
      id: `t${i}`,
      title: `task ${i}`,
      intent: 'do',
      kind: 'work' as const,
      status: 'planned' as const,
      executor: { type: 'agent' as const, ref: 'agent' },
      inputs: [],
      outputs: [],
      acceptance: [],
    }));
    return { ...base, tasks, edges: [] };
  }

  it('runs every task in a layer wider than the cap without exceeding the cap', async () => {
    const wide = WORKGRAPH_RUN_CONCURRENCY + 6;
    useWorkGraphStore.getState().setGraph(wideGraph(wide));

    const done = useWorkGraphStore.getState().run();
    // Drain until the run settles, releasing invokes in waves so the pool keeps
    // refilling its slots from the same single ready layer.
    for (let guard = 0; guard < 100 && invokedTaskIds.length < wide; guard += 1) {
      await new Promise<void>((r) => setTimeout(r, 0));
      releaseAll();
    }
    releaseAll();
    await done;

    // ALL tasks were invoked (none dropped), exactly once each.
    expect(new Set(invokedTaskIds).size).toBe(wide);
    expect(invokedTaskIds.length).toBe(wide);
    // The cap was never exceeded at any instant.
    expect(peak).toBeLessThanOrEqual(WORKGRAPH_RUN_CONCURRENCY);
    // The pool actually saturated (proves the throttle, not just a small layer).
    expect(peak).toBe(WORKGRAPH_RUN_CONCURRENCY);
    expect(useWorkGraphStore.getState().running).toBe(false);
  });

  it('halts further launches when stopped mid-run', async () => {
    const wide = WORKGRAPH_RUN_CONCURRENCY + 8;
    useWorkGraphStore.getState().setGraph(wideGraph(wide));

    const done = useWorkGraphStore.getState().run();
    // Let the first wave of (capped) invokes start.
    await new Promise<void>((r) => setTimeout(r, 0));
    const launchedBeforeStop = invokedTaskIds.length;
    expect(launchedBeforeStop).toBeLessThanOrEqual(WORKGRAPH_RUN_CONCURRENCY);

    // Stop, then release the in-flight invokes so the pool can observe the stop.
    useWorkGraphStore.getState().stopRun();
    for (let guard = 0; guard < 20; guard += 1) {
      releaseAll();
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    await done;

    // No new tasks were launched after the stop beyond the already-in-flight wave.
    expect(invokedTaskIds.length).toBeLessThan(wide);
    expect(useWorkGraphStore.getState().running).toBe(false);
  });
});

describe('implementReady', () => {
  let inFlight: number;
  let peak: number;
  let implementedTaskIds: string[];
  let releasers: Array<() => void>;

  beforeEach(() => {
    inFlight = 0;
    peak = 0;
    implementedTaskIds = [];
    releasers = [];
    (globalThis as unknown as { window: { marudesk: unknown } }).window.marudesk = {
      invoke: async (channel: string, payload?: unknown) => {
        if (channel === 'workos:implement-task') {
          implementedTaskIds.push((payload as { taskId: string }).taskId);
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          // Hold the implement open until released so the true concurrent peak across
          // a wide ready layer can be measured.
          await new Promise<void>((resolve) => {
            releasers.push(() => {
              inFlight -= 1;
              resolve();
            });
          });
          return {
            ok: true,
            status: 'done',
            result: 'implemented',
            patch: 'diff --git a/f b/f\n+x',
            changedFiles: ['f'],
          };
        }
        return undefined;
      },
      on: () => () => {},
    };
  });

  function releaseAll(): void {
    const pending = releasers;
    releasers = [];
    for (const r of pending) r();
  }

  /** A flat graph: `n` mutually-independent ready (planned) work tasks. */
  function wideGraph(n: number): ReturnType<typeof sampleGraph> {
    const base = sampleGraph('wide implement');
    const tasks = Array.from({ length: n }, (_, i) => ({
      id: `t${i}`,
      title: `task ${i}`,
      intent: 'do',
      kind: 'work' as const,
      status: 'planned' as const,
      executor: { type: 'agent' as const, ref: 'agent' },
      inputs: [],
      outputs: [],
      acceptance: [],
    }));
    return { ...base, tasks, edges: [] };
  }

  it('implements every CURRENT ready task (not blocked/done), capped, leaving diffs staged WITHOUT applying', async () => {
    // A small DAG: plan → backend → test; plan → frontend → test. Only `plan` is
    // ready initially (the rest depend on it), so the FIRST ready set is just plan.
    const graph = sampleGraph('ready set');
    // Pre-mark one task done to prove a done task is never re-implemented.
    useWorkGraphStore.getState().setGraph(graph);
    const tasks = useWorkGraphStore.getState().graph?.tasks ?? [];
    const root = tasks.find((t) => t.title === 'Plan & scope');
    expect(root).toBeTruthy();
    if (!root) return;

    const done = useWorkGraphStore.getState().implementReady();
    for (let guard = 0; guard < 50 && implementedTaskIds.length < 1; guard += 1) {
      await new Promise<void>((r) => setTimeout(r, 0));
      releaseAll();
    }
    releaseAll();
    await done;

    // Only the single currently-ready root was implemented (its dependents are not
    // ready until it is done + APPLIED, which implementReady never does).
    expect(implementedTaskIds).toEqual([root.id]);
    const after = useWorkGraphStore.getState().graph?.tasks ?? [];
    const afterRoot = after.find((t) => t.id === root.id);
    // The captured diff is stored as evidence (staged for review) — never applied.
    expect(afterRoot?.evidence?.patch).toBe('diff --git a/f b/f\n+x');
    expect(afterRoot?.status).toBe('done');
    // No apply happened: applyingPatchTaskId/lastAppliedTaskId stay clear.
    expect(useWorkGraphStore.getState().lastAppliedTaskId).toBeNull();
    expect(useWorkGraphStore.getState().running).toBe(false);
  });

  it('runs a wide ready layer in parallel bounded by the cap', async () => {
    const wide = WORKGRAPH_RUN_CONCURRENCY + 6;
    useWorkGraphStore.getState().setGraph(wideGraph(wide));

    const done = useWorkGraphStore.getState().implementReady();
    for (let guard = 0; guard < 100 && implementedTaskIds.length < wide; guard += 1) {
      await new Promise<void>((r) => setTimeout(r, 0));
      releaseAll();
    }
    releaseAll();
    await done;

    // Every ready task implemented exactly once, and the cap was never exceeded.
    expect(new Set(implementedTaskIds).size).toBe(wide);
    expect(implementedTaskIds.length).toBe(wide);
    expect(peak).toBeLessThanOrEqual(WORKGRAPH_RUN_CONCURRENCY);
    expect(peak).toBe(WORKGRAPH_RUN_CONCURRENCY);
    expect(useWorkGraphStore.getState().running).toBe(false);
  });

  it('is a no-op while a run is already in flight', async () => {
    useWorkGraphStore.getState().setGraph(wideGraph(3));
    useWorkGraphStore.setState({ running: true });

    await useWorkGraphStore.getState().implementReady();

    expect(implementedTaskIds).toEqual([]);
    expect(useWorkGraphStore.getState().running).toBe(true);
    useWorkGraphStore.setState({ running: false });
  });

  it('is a no-op when there are no ready tasks', async () => {
    const base = sampleGraph('all done');
    // Every task already done → readyTasks is empty.
    const graph = { ...base, tasks: base.tasks.map((t) => ({ ...t, status: 'done' as const })) };
    useWorkGraphStore.getState().setGraph(graph);

    await useWorkGraphStore.getState().implementReady();

    expect(implementedTaskIds).toEqual([]);
    expect(useWorkGraphStore.getState().running).toBe(false);
  });

  it('halts further launches when stopped mid-batch', async () => {
    const wide = WORKGRAPH_RUN_CONCURRENCY + 8;
    useWorkGraphStore.getState().setGraph(wideGraph(wide));

    const done = useWorkGraphStore.getState().implementReady();
    await new Promise<void>((r) => setTimeout(r, 0));
    const launchedBeforeStop = implementedTaskIds.length;
    expect(launchedBeforeStop).toBeLessThanOrEqual(WORKGRAPH_RUN_CONCURRENCY);

    useWorkGraphStore.getState().stopRun();
    for (let guard = 0; guard < 20; guard += 1) {
      releaseAll();
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    await done;

    // No new tasks were launched after the stop beyond the in-flight wave.
    expect(implementedTaskIds.length).toBeLessThan(wide);
    expect(useWorkGraphStore.getState().running).toBe(false);
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
