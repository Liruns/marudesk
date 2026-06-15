import { create } from 'zustand';
import { randomId } from '../../../shared/id';
import {
  hasCycle,
  parallelLayers,
  parseWorkGraph,
  readyTasks,
  type Authorship,
  type Criterion,
  type Edge,
  type Task,
  type TaskId,
  type TaskStatus,
  type WorkGraph,
} from '../../../shared/work-os';
import { useCanvasStore } from '../canvas/store';

/**
 * The AI Work OS task graph rendered as nodes on the canvas (docs/
 * ai-work-os-roadmap.md Phase 1 — the thinnest slice: generate → render → edit →
 * run → pass/fail). Distinct from the canvas placement store: this owns the
 * domain {@link WorkGraph} (tasks + directed, typed edges) and each node's
 * position keyed by `Task.id` (NOT a tab id), persisted under its own key so the
 * canvas-of-cards layout (`maru.canvas.*`) is never touched.
 *
 * Execution: a single graph for the slice. `runSimulate` walks the pure
 * scheduler (shared/work-os.ts) — running ready tasks, then their dependents in
 * layers — to make dependency order + parallelism visible without a provider;
 * real agent execution (electron/agent/run-task.ts, key-gated) drives the same
 * status transitions.
 */

export type NodePos = { x: number; y: number };

const PERSIST_KEY = 'maru.workgraph.v1';
const LAYOUT = { x0: 120, y0: 120, gapX: 320, gapY: 200 } as const;

// Task-node footprint — must match WorkGraphLayer's NODE_W / NODE_H. Kept local so
// the store doesn't import the view layer (which imports the store).
const TASK_NODE_W = 208;
const TASK_NODE_H = 118;
// Gutters used when an agent drops tasks into free space.
const TASK_GAP_X = 96; // between a task and the dependency it flows from
const TASK_GAP_Y = 56; // between stacked task rows
const FREE_GUTTER = 140; // clear band kept to the right of the existing tab cards

type Box = { x: number; y: number; w: number; h: number };

function boxesOverlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * A free top-left for a new task node at/near `anchor`, nudged straight DOWN past
 * any occupied box (existing tab cards + task nodes) so a generated task never
 * lands on top of a tab. Pure → unit-tested in store.test.ts.
 */
export function freeTaskSlot(anchor: NodePos, occupied: readonly Box[]): NodePos {
  const x = anchor.x;
  let y = anchor.y;
  const step = TASK_NODE_H + TASK_GAP_Y;
  for (let guard = 0; guard < 1000; guard += 1) {
    const cand: Box = { x, y, w: TASK_NODE_W, h: TASK_NODE_H };
    if (!occupied.some((o) => boxesOverlap(cand, o))) break;
    y += step;
  }
  return { x, y };
}

/** Every occupied box on the canvas plane: open tab cards + placed task nodes. */
function occupiedBoxes(taskPos: Record<TaskId, NodePos>, skipTaskId?: TaskId): Box[] {
  const boxes: Box[] = [];
  // Tab cards live in the same canvas-space as task nodes (CanvasStage's plane).
  try {
    for (const r of Object.values(useCanvasStore.getState().placements)) {
      boxes.push({ x: r.x, y: r.y, w: r.w, h: r.h });
    }
  } catch {
    // canvas store not ready (tests / headless) — task nodes alone still align.
  }
  for (const [id, p] of Object.entries(taskPos)) {
    if (id === skipTaskId) continue;
    boxes.push({ x: p.x, y: p.y, w: TASK_NODE_W, h: TASK_NODE_H });
  }
  return boxes;
}

/**
 * Where to drop an agent-created task. A task with placed dependencies flows to
 * the RIGHT of its rightmost parent (left→right dependency reading); a root task
 * starts in the clear band to the right of every existing tab card so the graph
 * never overlaps the user's tools. {@link freeTaskSlot} then resolves collisions.
 */
function agentTaskAnchor(
  parents: readonly NodePos[],
  occupied: readonly Box[],
): NodePos {
  if (parents.length > 0) {
    const x = Math.max(...parents.map((p) => p.x)) + TASK_NODE_W + TASK_GAP_X;
    const y = Math.min(...parents.map((p) => p.y));
    return { x, y };
  }
  // Root: right of all existing content (default to the legacy origin if empty).
  const right = occupied.reduce((m, b) => Math.max(m, b.x + b.w), Number.NEGATIVE_INFINITY);
  const top = occupied.reduce((m, b) => Math.min(m, b.y), Number.POSITIVE_INFINITY);
  const x = Number.isFinite(right) ? right + FREE_GUTTER : LAYOUT.x0;
  const y = Number.isFinite(top) ? top : LAYOUT.y0;
  return { x, y };
}

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

/** A fresh `work` task with the standard defaults (agent executor, empty I/O). */
function makeTask(fields: {
  id?: string;
  title: string;
  intent: string;
  author: Authorship;
  acceptance?: Criterion[];
  group?: string;
  handoff?: string;
  tools?: string[];
}): Task {
  return {
    id: fields.id ?? randomId('task'),
    title: fields.title,
    intent: fields.intent,
    kind: 'work',
    status: 'planned',
    author: fields.author,
    executor: { type: 'agent', ref: 'agent' },
    inputs: [],
    outputs: [],
    acceptance: fields.acceptance ?? [],
    ...(fields.group ? { group: fields.group } : {}),
    ...(fields.handoff ? { handoff: fields.handoff } : {}),
    ...(fields.tools && fields.tools.length > 0 ? { tools: fields.tools } : {}),
  };
}

type WorkGraphState = {
  graph: WorkGraph | null;
  pos: Record<TaskId, NodePos>;
  selectedTaskId: TaskId | null;
  /** A simulate run is in flight (drives the Run button + disables edits). */
  running: boolean;
};

type WorkGraphActions = {
  /** Replace the whole graph (from the decomposer or a sample) + auto-layout. */
  setGraph: (graph: WorkGraph) => void;
  clearGraph: () => void;
  addTask: (at?: NodePos) => TaskId;
  /**
   * Materialize an agent-created task (the `create_task` MCP tool). Places it in
   * free space — flowing right of its dependencies, never over a tab card — wires
   * `depends_on` edges for any `dependsOn` that already exist, and seeds the graph
   * goal on the first task. Returns the task id.
   */
  addTaskFromAgent: (spec: {
    id?: string;
    title: string;
    intent?: string;
    acceptance?: string[];
    dependsOn?: readonly string[];
    goal?: string;
    /** Named section to cluster this task with its siblings. */
    group?: string;
    /** Context / plan this task hands to its dependents. */
    handoff?: string;
    /** Tools the task expects to use. */
    tools?: readonly string[];
  }) => TaskId;
  updateTask: (
    id: TaskId,
    patch: Partial<Pick<Task, 'title' | 'intent' | 'status' | 'kind' | 'group' | 'handoff'>>,
  ) => void;
  deleteTask: (id: TaskId) => void;
  setPos: (id: TaskId, x: number, y: number) => void;
  selectTask: (id: TaskId | null) => void;
  /** Add a `depends_on` edge (no-op on self / duplicate / would-be cycle). */
  connect: (from: TaskId, to: TaskId) => void;
  removeEdge: (edgeId: string) => void;
  /** Add an acceptance criterion to a task. */
  addCriterion: (id: TaskId, text: string) => void;
  setCriterionVerdict: (id: TaskId, criterionId: string, verdict: Criterion['verdict']) => void;
  /** Reset every task to `planned` (and clear verdicts) — re-arm a run. */
  resetRun: () => void;
  /** Dependency-ordered simulated run (no provider needed); resolves when done. */
  runSimulate: () => Promise<void>;
};

const persisted = loadPersisted();

function setStatus(graph: WorkGraph, id: TaskId, status: TaskStatus): WorkGraph {
  return touch({
    ...graph,
    tasks: graph.tasks.map((t) => (t.id === id ? { ...t, status } : t)),
  });
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const useWorkGraphStore = create<WorkGraphState & WorkGraphActions>((set, get) => ({
  graph: persisted.graph,
  pos: persisted.pos,
  selectedTaskId: null,
  running: false,

  setGraph: (graph) => set({ graph: touch(graph), pos: autoLayout(graph), selectedTaskId: null, running: false }),

  clearGraph: () => set({ graph: null, pos: {}, selectedTaskId: null, running: false }),

  addTask: (at) => {
    const id = randomId('task');
    set((s) => {
      // Human-added from the canvas controls → authored 'human'.
      const task = makeTask({ id, title: 'New task', intent: s.graph?.goal ?? '', author: 'human' });
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

  addTaskFromAgent: (spec) => {
    const id = spec.id ?? randomId('task');
    set((s) => {
      const base: WorkGraph = s.graph ?? {
        id: randomId('wg'),
        goal: spec.goal?.trim() ?? '',
        tasks: [],
        edges: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const goal = base.goal || spec.goal?.trim() || '';
      const tools = (spec.tools ?? []).map((v) => v.trim()).filter(Boolean);
      const task = makeTask({
        id,
        title: spec.title.trim() || 'New task',
        intent: spec.intent?.trim() || goal,
        author: 'agent',
        acceptance: (spec.acceptance ?? [])
          .map((text) => text.trim())
          .filter(Boolean)
          .map((text) => ({ id: randomId('crit'), text, verdict: 'unknown' as const })),
        ...(spec.group?.trim() ? { group: spec.group.trim() } : {}),
        ...(spec.handoff?.trim() ? { handoff: spec.handoff.trim() } : {}),
        ...(tools.length > 0 ? { tools } : {}),
      });

      // Wire depends_on edges for parents that already exist (skip self / cycles).
      const existingIds = new Set(base.tasks.map((t) => t.id));
      const parents = (spec.dependsOn ?? []).filter((p) => p !== id && existingIds.has(p));
      let edges = base.edges;
      for (const from of parents) {
        const edgeId = `${from}~${id}~depends_on`;
        if (edges.some((e) => e.id === edgeId)) continue;
        const candidate = { ...base, tasks: [...base.tasks, task], edges: [...edges, { id: edgeId, from, to: id, type: 'depends_on' as const }] };
        if (hasCycle(candidate)) continue;
        edges = [...edges, { id: edgeId, from, to: id, type: 'depends_on' as const }];
      }

      // Place it in free space: right of its parents, else right of every card.
      const parentPos = parents.map((p) => s.pos[p]).filter((p): p is NodePos => !!p);
      const occupied = occupiedBoxes(s.pos, id);
      const at = freeTaskSlot(agentTaskAnchor(parentPos, occupied), occupied);

      return {
        graph: touch({ ...base, goal, tasks: [...base.tasks, task], edges }),
        pos: { ...s.pos, [id]: at },
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

  runSimulate: async () => {
    if (get().running || !get().graph) return;
    get().resetRun();
    set({ running: true });
    // Drive the pure scheduler: each pass runs every currently-ready task (the
    // parallel set), marks them done, and repeats until nothing is ready.
    let guard = 0;
    while (get().running && guard < 1000) {
      guard += 1;
      const graph = get().graph;
      if (!graph) break;
      const ready = readyTasks(graph);
      if (ready.length === 0) break;
      // Start the whole ready set (parallelism), then complete it.
      set((s) => (s.graph ? { graph: ready.reduce((g, t) => setStatus(g, t.id, 'running'), s.graph) } : {}));
      await delay(260);
      if (!get().running) break;
      set((s) => {
        if (!s.graph) return {};
        let g = s.graph;
        for (const t of ready) {
          g = setStatus(g, t.id, 'done');
          g = {
            ...g,
            tasks: g.tasks.map((x) =>
              x.id === t.id ? { ...x, acceptance: x.acceptance.map((c) => ({ ...c, verdict: 'pass' as const, checkedAt: Date.now() })) } : x,
            ),
          };
        }
        return { graph: g };
      });
      await delay(120);
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
  const mk = (title: string, intent: string, acceptance: string[]): Task =>
    makeTask({
      title,
      intent,
      author: 'agent',
      group: g,
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
