import { create } from 'zustand';
import { randomId } from '../../../shared/id';
import {
  hasCycle,
  parallelLayers,
  parseWorkGraph,
  readyTasks,
  type Criterion,
  type Edge,
  type Resource,
  type Task,
  type TaskId,
  type TaskStatus,
  type WorkGraph,
} from '../../../shared/work-os';

/**
 * The AI Work OS task graph rendered as nodes on the canvas (docs/
 * ai-work-os-roadmap.md Phase 1 — the thinnest slice: generate → render → edit →
 * run → pass/fail). Distinct from the canvas placement store: this owns the
 * domain {@link WorkGraph} (tasks + directed, typed edges) and each node's
 * position keyed by `Task.id` (NOT a tab id), persisted under its own key so the
 * canvas-of-cards layout (`maru.canvas.*`) is never touched.
 *
 * Execution: a single graph for the slice. `run` walks the pure scheduler
 * (shared/work-os.ts) in dependency/parallel order and executes each ready task
 * as a REAL agent via the `workos:run-task` IPC (electron/agent/run-task.ts),
 * storing the agent's report as `Task.evidence`. With no provider connected it
 * falls back to a **dry run** (advances STATUS only) so the loop is always
 * demoable. Acceptance verdicts stay 'unknown' until system-verified — never
 * faked from the agent's own claim (docs/ai-work-os-roadmap.md §4).
 */

export type NodePos = { x: number; y: number };

const PERSIST_KEY = 'maru.workgraph.v1';
const LAYOUT = { x0: 120, y0: 120, gapX: 320, gapY: 200 } as const;

type Persisted = { graph: WorkGraph | null; pos: Record<TaskId, NodePos> };

function loadPersisted(): Persisted {
  try {
    if (typeof localStorage === 'undefined') return { graph: null, pos: {} };
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return { graph: null, pos: {} };
    const data: unknown = JSON.parse(raw);
    if (typeof data !== 'object' || data === null) return { graph: null, pos: {} };
    const rec = data as Record<string, unknown>;
    const graph = parseWorkGraph(rec.graph);
    const pos: Record<TaskId, NodePos> = {};
    if (graph && typeof rec.pos === 'object' && rec.pos !== null) {
      for (const [id, v] of Object.entries(rec.pos as Record<string, unknown>)) {
        const p = v as Record<string, unknown>;
        if (typeof p?.x === 'number' && typeof p?.y === 'number') pos[id] = { x: p.x, y: p.y };
      }
    }
    return { graph, pos };
  } catch {
    return { graph: null, pos: {} };
  }
}

/** Lay nodes out left→right by dependency layer so a fresh graph doesn't stack. */
function autoLayout(graph: WorkGraph): Record<TaskId, NodePos> {
  const pos: Record<TaskId, NodePos> = {};
  const layers = parallelLayers(graph) ?? [graph.tasks.map((t) => t.id)];
  layers.forEach((layer, col) => {
    layer.forEach((id, row) => {
      pos[id] = { x: LAYOUT.x0 + col * LAYOUT.gapX, y: LAYOUT.y0 + row * LAYOUT.gapY };
    });
  });
  return pos;
}

function touch(graph: WorkGraph): WorkGraph {
  return { ...graph, updatedAt: Date.now() };
}

type WorkGraphState = {
  graph: WorkGraph | null;
  pos: Record<TaskId, NodePos>;
  selectedTaskId: TaskId | null;
  /** A run is in flight (drives the Run button + disables edits). */
  running: boolean;
  /** A short notice from the last run (e.g. the dry-run fallback reason), or null. */
  runNote: string | null;
};

type WorkGraphActions = {
  /** Replace the whole graph (from the decomposer or a sample) + auto-layout. */
  setGraph: (graph: WorkGraph) => void;
  clearGraph: () => void;
  addTask: (at?: NodePos) => TaskId;
  updateTask: (id: TaskId, patch: Partial<Pick<Task, 'title' | 'intent' | 'status' | 'kind'>>) => void;
  deleteTask: (id: TaskId) => void;
  setPos: (id: TaskId, x: number, y: number) => void;
  selectTask: (id: TaskId | null) => void;
  /** Add a `depends_on` edge (no-op on self / duplicate / would-be cycle). */
  connect: (from: TaskId, to: TaskId) => void;
  removeEdge: (edgeId: string) => void;
  /** Add an acceptance criterion to a task. */
  addCriterion: (id: TaskId, text: string) => void;
  setCriterionVerdict: (id: TaskId, criterionId: string, verdict: Criterion['verdict']) => void;
  /** Reset every task to `planned` (and clear verdicts/evidence) — re-arm a run. */
  resetRun: () => void;
  /**
   * Run the graph: walks the scheduler in dependency/parallel order and executes
   * each ready task as a REAL agent (`workos:run-task`), storing its report as
   * `Task.evidence` and its outcome as status. Falls back to a dry run (status
   * only, no provider needed) when no AI provider is connected — so the loop is
   * always demoable. Acceptance verdicts stay 'unknown' until system-verified.
   * Resolves when the walk completes (or `running` is flipped off to stop).
   */
  run: () => Promise<void>;
};

const persisted = loadPersisted();

function setStatus(graph: WorkGraph, id: TaskId, status: TaskStatus): WorkGraph {
  return touch({
    ...graph,
    tasks: graph.tasks.map((t) => (t.id === id ? { ...t, status } : t)),
  });
}

/** Attach (or update) a task's evidence result, preserving any trajectory. */
function setEvidence(graph: WorkGraph, id: TaskId, result: string): WorkGraph {
  return touch({
    ...graph,
    tasks: graph.tasks.map((t) =>
      t.id === id ? { ...t, evidence: { trajectory: t.evidence?.trajectory ?? [], result } } : t,
    ),
  });
}

/** Replace a task's output resources (the real files its agent run identified). */
function setOutputs(graph: WorkGraph, id: TaskId, outputs: Resource[]): WorkGraph {
  return touch({
    ...graph,
    tasks: graph.tasks.map((t) => (t.id === id ? { ...t, outputs } : t)),
  });
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const useWorkGraphStore = create<WorkGraphState & WorkGraphActions>((set, get) => ({
  graph: persisted.graph,
  pos: persisted.pos,
  selectedTaskId: null,
  running: false,
  runNote: null,

  setGraph: (graph) => set({ graph: touch(graph), pos: autoLayout(graph), selectedTaskId: null, running: false, runNote: null }),

  clearGraph: () => set({ graph: null, pos: {}, selectedTaskId: null, running: false, runNote: null }),

  addTask: (at) => {
    const id = randomId('task');
    set((s) => {
      const task: Task = {
        id,
        title: 'New task',
        intent: s.graph?.goal ?? '',
        kind: 'work',
        status: 'planned',
        executor: { type: 'agent', ref: 'agent' },
        inputs: [],
        outputs: [],
        acceptance: [],
      };
      const base: WorkGraph = s.graph ?? {
        id: randomId('wg'),
        goal: '',
        tasks: [],
        edges: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const count = base.tasks.length;
      return {
        graph: touch({ ...base, tasks: [...base.tasks, task] }),
        pos: {
          ...s.pos,
          [id]: at ?? { x: LAYOUT.x0 + (count % 3) * LAYOUT.gapX, y: LAYOUT.y0 + Math.floor(count / 3) * LAYOUT.gapY },
        },
        selectedTaskId: id,
      };
    });
    return id;
  },

  updateTask: (id, patch) =>
    set((s) => {
      if (!s.graph) return {};
      return { graph: touch({ ...s.graph, tasks: s.graph.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) }) };
    }),

  deleteTask: (id) =>
    set((s) => {
      if (!s.graph) return {};
      const pos = { ...s.pos };
      delete pos[id];
      return {
        graph: touch({
          ...s.graph,
          tasks: s.graph.tasks.filter((t) => t.id !== id),
          edges: s.graph.edges.filter((e) => e.from !== id && e.to !== id),
        }),
        pos,
        selectedTaskId: s.selectedTaskId === id ? null : s.selectedTaskId,
      };
    }),

  setPos: (id, x, y) => set((s) => ({ pos: { ...s.pos, [id]: { x, y } } })),

  selectTask: (id) => set({ selectedTaskId: id }),

  connect: (from, to) =>
    set((s) => {
      if (!s.graph || from === to) return {};
      const id = `${from}~${to}~depends_on`;
      if (s.graph.edges.some((e) => e.id === id)) return {};
      const edge: Edge = { id, from, to, type: 'depends_on' };
      const next = { ...s.graph, edges: [...s.graph.edges, edge] };
      // Reject an edge that would introduce a dependency cycle.
      if (hasCycle(next)) return {};
      return { graph: touch(next) };
    }),

  removeEdge: (edgeId) =>
    set((s) => (s.graph ? { graph: touch({ ...s.graph, edges: s.graph.edges.filter((e) => e.id !== edgeId) }) } : {})),

  addCriterion: (id, text) =>
    set((s) => {
      if (!s.graph || !text.trim()) return {};
      const crit: Criterion = { id: randomId('crit'), text: text.trim(), verdict: 'unknown' };
      return {
        graph: touch({
          ...s.graph,
          tasks: s.graph.tasks.map((t) => (t.id === id ? { ...t, acceptance: [...t.acceptance, crit] } : t)),
        }),
      };
    }),

  setCriterionVerdict: (id, criterionId, verdict) =>
    set((s) => {
      if (!s.graph) return {};
      return {
        graph: touch({
          ...s.graph,
          tasks: s.graph.tasks.map((t) =>
            t.id === id
              ? {
                  ...t,
                  acceptance: t.acceptance.map((c) =>
                    c.id === criterionId ? { ...c, verdict, checkedAt: Date.now() } : c,
                  ),
                }
              : t,
          ),
        }),
      };
    }),

  resetRun: () =>
    set((s) => {
      if (!s.graph) return {};
      return {
        running: false,
        runNote: null,
        graph: touch({
          ...s.graph,
          tasks: s.graph.tasks.map((t) => ({
            ...t,
            status: 'planned',
            acceptance: t.acceptance.map((c) => ({ ...c, verdict: 'unknown' as const })),
          })),
        }),
      };
    }),

  run: async () => {
    if (get().running || !get().graph) return;
    get().resetRun();
    set({ running: true, runNote: null });
    // Drive the pure scheduler one ready-set (parallel layer) at a time. Each
    // ready task runs as a REAL agent via `workos:run-task`; if no provider is
    // connected we fall back to a dry run (status only) for the rest so the loop
    // is always demoable and e2e-testable offline.
    let live = true;
    let guard = 0;
    while (get().running && guard < 1000) {
      guard += 1;
      const graph = get().graph;
      if (!graph) break;
      const ready = readyTasks(graph);
      if (ready.length === 0) break;
      const goal = graph.goal;
      // Mark the whole ready set running (visualizes the parallel layer).
      set((s) => (s.graph ? { graph: ready.reduce((g, t) => setStatus(g, t.id, 'running'), s.graph) } : {}));

      if (live) {
        const outcomes = await Promise.all(
          ready.map(async (t) => ({
            t,
            res: await window.marudesk.invoke('workos:run-task', {
              taskId: t.id,
              title: t.title,
              intent: t.intent,
              goal,
              acceptance: t.acceptance.map((c) => c.text),
            }),
          })),
        );
        if (!get().running) break;
        // No provider for the entire ready set → switch to a dry run from here.
        if (outcomes.every((o) => !o.res.ok)) {
          live = false;
          const first = outcomes[0]?.res;
          set({ runNote: first && !first.ok ? first.reason : 'No provider — showing a dry run (status only).' });
          set((s) => (s.graph ? { graph: ready.reduce((g, t) => setStatus(g, t.id, 'done'), s.graph) } : {}));
          await delay(220);
          continue;
        }
        set((s) => {
          if (!s.graph) return {};
          let g = s.graph;
          for (const { t, res } of outcomes) {
            if (res.ok) {
              g = setStatus(g, t.id, res.status);
              g = setEvidence(g, t.id, res.result);
              g = setOutputs(g, t.id, res.outputs);
            } else {
              g = setStatus(g, t.id, 'failed');
              g = setEvidence(g, t.id, res.reason);
            }
          }
          return { graph: g };
        });
      } else {
        await delay(220);
        if (!get().running) break;
        set((s) => {
          if (!s.graph) return {};
          let g = s.graph;
          for (const t of ready) g = setStatus(g, t.id, 'done');
          return { graph: g };
        });
      }
    }
    set({ running: false });
  },
}));

/* persist (debounced via microtask) — graph + node positions only. */
let saveQueued = false;
useWorkGraphStore.subscribe(() => {
  if (typeof localStorage === 'undefined' || saveQueued) return;
  saveQueued = true;
  queueMicrotask(() => {
    saveQueued = false;
    try {
      const { graph, pos } = useWorkGraphStore.getState();
      localStorage.setItem(PERSIST_KEY, JSON.stringify({ graph, pos }));
    } catch {
      // best-effort
    }
  });
});

/**
 * A deterministic sample graph for a goal — used when no AI provider is
 * configured (so the loop is always demoable + e2e-testable) and as the
 * decomposer's offline fallback. Shape mirrors what `decompose` produces: a
 * small DAG with a fan-out and a join.
 */
export function sampleGraph(goal: string): WorkGraph {
  const g = goal.trim() || 'Ship the feature';
  const mk = (title: string, intent: string, acceptance: string[]): Task => ({
    id: randomId('task'),
    title,
    intent,
    kind: 'work',
    status: 'planned',
    executor: { type: 'agent', ref: 'agent' },
    inputs: [],
    outputs: [],
    acceptance: acceptance.map((text) => ({ id: randomId('crit'), text, verdict: 'unknown' as const })),
  });
  const plan = mk('Plan & scope', `Break down: ${g}`, ['Scope is written down', 'Risks listed']);
  const backend = mk('Implement backend', g, ['Endpoints return 200', 'npm run typecheck passes']);
  const frontend = mk('Implement UI', g, ['Renders without console errors']);
  const test = mk('Test & verify', `Verify: ${g}`, ['All tests pass', 'No regressions']);
  const tasks = [plan, backend, frontend, test];
  const dep = (from: Task, to: Task): Edge => ({ id: `${from.id}~${to.id}~depends_on`, from: from.id, to: to.id, type: 'depends_on' });
  return {
    id: randomId('wg'),
    goal: g,
    tasks,
    edges: [dep(plan, backend), dep(plan, frontend), dep(backend, test), dep(frontend, test)],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}
