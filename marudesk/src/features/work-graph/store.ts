import { create } from 'zustand';
import { randomId } from '../../../shared/id';
import {
  blockedTaskIds,
  edgeId,
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
import { useCanvasStore } from '../canvas/store';

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

/** Outcome of a connect() attempt, so the UI can explain a rejection. */
export type ConnectResult = { ok: true } | { ok: false; reason: 'self' | 'duplicate' | 'cycle' };

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
    // Only keep positions for tasks the parser actually kept — parseWorkGraph can
    // drop malformed/duplicate tasks, and an orphan pos entry would bloat storage
    // and skew Fit / connect hit-tests toward phantom ids.
    const live = new Set(graph?.tasks.map((t) => t.id));
    if (graph && typeof rec.pos === 'object' && rec.pos !== null) {
      for (const [id, v] of Object.entries(rec.pos as Record<string, unknown>)) {
        const p = v as Record<string, unknown>;
        if (live.has(id) && typeof p?.x === 'number' && typeof p?.y === 'number') pos[id] = { x: p.x, y: p.y };
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
function makeTask(fields: { id?: string; title: string; intent: string; acceptance?: Criterion[] }): Task {
  return {
    id: fields.id ?? randomId('task'),
    title: fields.title,
    intent: fields.intent,
    kind: 'work',
    status: 'planned',
    executor: { type: 'agent', ref: 'agent' },
    inputs: [],
    outputs: [],
    acceptance: fields.acceptance ?? [],
  };
}

type WorkGraphState = {
  graph: WorkGraph | null;
  pos: Record<TaskId, NodePos>;
  selectedTaskId: TaskId | null;
  /** A run is in flight (drives the Run button + disables edits). */
  running: boolean;
  /**
   * Monotonic token for the active run/implement. Bumped by {@link stopRun} and by
   * each new run so a superseded in-flight turn can detect it lost ownership after
   * an await and bail without clobbering the newer turn's state.
   */
  runToken: number;
  /** A short notice from the last run (e.g. the dry-run fallback reason), or null. */
  runNote: string | null;
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
  }) => TaskId;
  updateTask: (id: TaskId, patch: Partial<Pick<Task, 'title' | 'intent' | 'status' | 'kind'>>) => void;
  deleteTask: (id: TaskId) => void;
  setPos: (id: TaskId, x: number, y: number) => void;
  selectTask: (id: TaskId | null) => void;
  /** Add a `depends_on` edge; returns why it was rejected (self / duplicate / cycle). */
  connect: (from: TaskId, to: TaskId) => ConnectResult;
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
  /**
   * Implement ONE task write-capably in an isolated git worktree (`workos:implement-task`)
   * and store the captured diff as `Task.evidence.patch` for review. The live
   * workspace is never modified. No-op while a run is in flight.
   */
  implementTask: (id: TaskId) => Promise<void>;
  /** Stop the active run/implement: invalidate its token + return running tasks to planned. */
  stopRun: () => void;
};

const persisted = loadPersisted();

function setStatus(graph: WorkGraph, id: TaskId, status: TaskStatus): WorkGraph {
  return touch({
    ...graph,
    tasks: graph.tasks.map((t) => (t.id === id ? { ...t, status } : t)),
  });
}

/** Attach (or update) a task's evidence result (+ optional diff), keeping any trajectory. */
function setEvidence(graph: WorkGraph, id: TaskId, result: string, patch?: string): WorkGraph {
  return touch({
    ...graph,
    tasks: graph.tasks.map((t) =>
      t.id === id
        ? {
            ...t,
            evidence: { trajectory: t.evidence?.trajectory ?? [], result, ...(patch ? { patch } : {}) },
          }
        : t,
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

/** Mark every task transitively blocked by a failed/blocked upstream as `blocked`. */
function markBlocked(graph: WorkGraph): WorkGraph {
  let g = graph;
  for (const id of blockedTaskIds(g)) g = setStatus(g, id, 'blocked');
  return g;
}

/** Note stamped on a dry-run-advanced task so the UI never reads it as verified. */
const DRY_RUN_NOTE = 'Dry run — no provider connected; status only, not verified.';

/** Advance a ready set as a DRY run: status done + an explicit "not verified" note. */
function markDry(graph: WorkGraph, tasks: readonly Task[]): WorkGraph {
  let g = graph;
  for (const t of tasks) {
    g = setStatus(g, t.id, 'done');
    g = setEvidence(g, t.id, DRY_RUN_NOTE);
  }
  return g;
}

/**
 * A copy of the graph with per-task `evidence` dropped. Evidence (the agent's
 * result text + up-to-20k diff, possibly containing file contents) is run-session
 * state: `parseWorkGraph` never restores it, so persisting it is pure bloat AND a
 * needless way for file contents to land in localStorage. Strip it before saving.
 */
function withoutEvidence(graph: WorkGraph): WorkGraph {
  return {
    ...graph,
    tasks: graph.tasks.map((t) => {
      if (!t.evidence) return t;
      const copy = { ...t };
      delete copy.evidence;
      return copy;
    }),
  };
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const useWorkGraphStore = create<WorkGraphState & WorkGraphActions>((set, get) => ({
  graph: persisted.graph,
  pos: persisted.pos,
  selectedTaskId: null,
  running: false,
  runToken: 0,
  runNote: null,

  setGraph: (graph) =>
    set((s) => ({
      graph: touch(graph),
      pos: autoLayout(graph),
      selectedTaskId: null,
      running: false,
      runToken: s.runToken + 1, // invalidate any in-flight run/implement
      runNote: null,
    })),

  clearGraph: () =>
    set((s) => ({
      graph: null,
      pos: {},
      selectedTaskId: null,
      running: false,
      runToken: s.runToken + 1,
      runNote: null,
    })),

  addTask: (at) => {
    const id = randomId('task');
    set((s) => {
      const task = makeTask({ id, title: 'New task', intent: s.graph?.goal ?? '' });
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
      const task = makeTask({
        id,
        title: spec.title.trim() || 'New task',
        intent: spec.intent?.trim() || goal,
        acceptance: (spec.acceptance ?? [])
          .map((text) => text.trim())
          .filter(Boolean)
          .map((text) => ({ id: randomId('crit'), text, verdict: 'unknown' as const })),
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

  connect: (from, to) => {
    if (from === to) return { ok: false, reason: 'self' };
    const s = get();
    if (!s.graph) return { ok: false, reason: 'duplicate' }; // no graph — nothing to connect (unreachable from UI)
    const id = edgeId(from, to);
    if (s.graph.edges.some((e) => e.id === id)) return { ok: false, reason: 'duplicate' };
    const edge: Edge = { id, from, to, type: 'depends_on' };
    const next = { ...s.graph, edges: [...s.graph.edges, edge] };
    if (hasCycle(next)) return { ok: false, reason: 'cycle' };
    set({ graph: touch(next) });
    return { ok: true };
  },

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
          tasks: s.graph.tasks.map((t): Task => {
            const next: Task = {
              ...t,
              status: 'planned',
              outputs: [],
              acceptance: t.acceptance.map((c) => ({ ...c, verdict: 'unknown' as const })),
            };
            delete next.evidence; // re-arm: drop the prior run's result/diff
            return next;
          }),
        }),
      };
    }),

  run: async () => {
    if (get().running || !get().graph) return;
    get().resetRun();
    const token = get().runToken + 1;
    set({ running: true, runToken: token, runNote: null });
    // This turn owns the run only while its token is current; a stopRun() or a new
    // run bumps the token, and we bail after the next await instead of clobbering.
    const owns = () => get().running && get().runToken === token;
    let live = true;
    let ranLive = false; // true once any task has actually run on a provider
    let guard = 0;
    try {
      while (owns() && guard < 1000) {
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
              // Fail-closed: a rejected invoke (child threw) becomes an ok:false
              // result, not an unhandled rejection that strands the layer.
              res: await window.marudesk
                .invoke('workos:run-task', {
                  taskId: t.id,
                  title: t.title,
                  intent: t.intent,
                  goal,
                  acceptance: t.acceptance.map((c) => c.text),
                })
                .catch(() => ({ ok: false as const, reason: 'The task agent could not be reached.' })),
            })),
          );
          if (!owns()) break;
          if (outcomes.every((o) => !o.res.ok)) {
            if (!ranLive) {
              // Nothing has run live yet → a legitimate offline PREVIEW: advance
              // status as a clearly-labelled dry run for the rest of the graph.
              live = false;
              const first = outcomes[0]?.res;
              set({ runNote: first && !first.ok ? first.reason : 'No provider — showing a dry run (status only).' });
              set((s) => (s.graph ? { graph: markDry(s.graph, ready) } : {}));
              await delay(220);
              continue;
            }
            // We already ran tasks for real and the provider then dropped — do NOT
            // fake success for the rest. Mark them blocked and stop honestly.
            set({ runNote: 'Provider became unavailable — remaining tasks were not run.' });
            set((s) => {
              if (!s.graph) return {};
              let g = s.graph;
              for (const t of ready) g = setStatus(g, t.id, 'blocked');
              return { graph: markBlocked(g) };
            });
            break;
          }
          if (outcomes.some((o) => o.res.ok)) ranLive = true;
          set((s) => {
            if (!s.graph) return {};
            let g = s.graph;
            for (const { t, res } of outcomes) {
              if (res.ok) {
                g = setStatus(g, t.id, res.status);
                g = setEvidence(g, t.id, res.result);
                g = setOutputs(g, t.id, res.outputs);
              } else {
                // Not attempted (no provider / timeout for THIS task) — `blocked`,
                // not a real `failed`: non-terminal, recoverable, and it won't
                // cascade-fail dependents the way a genuine failure does.
                g = setStatus(g, t.id, 'blocked');
                g = setEvidence(g, t.id, res.reason);
              }
            }
            // A failed task blocks its dependents — mark them so they don't sit planned.
            return { graph: markBlocked(g) };
          });
        } else {
          await delay(220);
          if (!owns()) break;
          set((s) => (s.graph ? { graph: markDry(s.graph, ready) } : {}));
        }
      }
    } finally {
      // Only the owning turn clears `running` (a newer run/stop owns it otherwise).
      if (get().runToken === token) set({ running: false });
    }
  },

  implementTask: async (id) => {
    const s0 = get();
    if (s0.running || !s0.graph) return;
    const task = s0.graph.tasks.find((t) => t.id === id);
    if (!task) return;
    const goal = s0.graph.goal;
    const token = s0.runToken + 1;
    set((s) => ({
      running: true,
      runToken: token,
      runNote: null,
      graph: s.graph ? setStatus(s.graph, id, 'running') : s.graph,
    }));
    try {
      const res = await window.marudesk.invoke('workos:implement-task', {
        taskId: task.id,
        title: task.title,
        intent: task.intent,
        goal,
        acceptance: task.acceptance.map((c) => c.text),
      });
      if (get().runToken !== token) return; // stopped / superseded — don't clobber
      set((s) => {
        if (!s.graph) return { running: false };
        if (res.ok) {
          let g = setStatus(s.graph, id, res.status);
          g = setEvidence(g, id, res.result, res.patch);
          return {
            graph: g,
            running: false,
            runNote: res.changedFiles.length
              ? `${res.changedFiles.length} file(s) changed in an isolated worktree — review the diff before applying.`
              : 'No changes were produced.',
          };
        }
        // A precondition (no provider / not a git repo) — restore the task to planned.
        return { graph: setStatus(s.graph, id, 'planned'), running: false, runNote: res.reason };
      });
    } catch {
      if (get().runToken !== token) return;
      set((s) => ({
        graph: s.graph ? setStatus(s.graph, id, 'planned') : s.graph,
        running: false,
        runNote: 'Implement failed.',
      }));
    }
  },

  stopRun: () =>
    set((s) => {
      const runToken = s.runToken + 1;
      if (!s.graph) return { running: false, runToken };
      // Return any in-flight task to planned so it isn't stranded as `running`.
      const graph = touch({
        ...s.graph,
        tasks: s.graph.tasks.map((t) => (t.status === 'running' ? { ...t, status: 'planned' as const } : t)),
      });
      return { running: false, runToken, graph };
    }),
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
      // Evidence (result text + diff) is run-session only and not restored on load;
      // strip it so file contents never sit in localStorage (and to avoid bloat).
      localStorage.setItem(PERSIST_KEY, JSON.stringify({ graph: graph ? withoutEvidence(graph) : null, pos }));
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
      acceptance: acceptance.map((text) => ({ id: randomId('crit'), text, verdict: 'unknown' as const })),
    });
  const plan = mk('Plan & scope', `Break down: ${g}`, ['Scope is written down', 'Risks listed']);
  const backend = mk('Implement backend', g, ['Endpoints return 200', 'npm run typecheck passes']);
  const frontend = mk('Implement UI', g, ['Renders without console errors']);
  const test = mk('Test & verify', `Verify: ${g}`, ['All tests pass', 'No regressions']);
  const tasks = [plan, backend, frontend, test];
  const dep = (from: Task, to: Task): Edge => ({ id: edgeId(from.id, to.id), from: from.id, to: to.id, type: 'depends_on' });
  return {
    id: randomId('wg'),
    goal: g,
    tasks,
    edges: [dep(plan, backend), dep(plan, frontend), dep(backend, test), dep(frontend, test)],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}
