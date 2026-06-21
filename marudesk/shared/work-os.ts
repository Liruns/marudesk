/**
 * Maru AI Work OS — the Task-graph domain model (docs/ai-work-os-roadmap.md §1).
 *
 * One node type: **Task**. Goal = the root task's `intent`; Agent = a task's
 * `executor`; Decision = `kind: 'decision'`; Resource = an input/output artifact
 * hung off a task (not a node). Edges are **directed and typed** (`depends_on` /
 * `data`) — the decisive difference from the canvas's untyped, undirected
 * `Edge` (src/features/canvas/store.ts).
 *
 * Pure module: zero imports, safe to share across main, renderer, and tests
 * (the `marudesk/shared/*` rule). Every union ships a type guard (the repo-wide
 * convention — `isSpecStatus` in specs.ts, `isProviderId` in providers.ts) so
 * the same predicate validates AI-generated JSON, IPC boundaries, and persisted
 * state.
 */

export type TaskId = string;
export type ResourceId = string;
export type EdgeId = string;

export type TaskKind = 'work' | 'decision';
export const TASK_KINDS: readonly TaskKind[] = ['work', 'decision'];

export type TaskStatus =
  | 'planned'
  | 'running'
  | 'blocked'
  | 'done'
  | 'failed'
  | 'needs_review';

export const TASK_STATUSES: readonly TaskStatus[] = [
  'planned',
  'running',
  'blocked',
  'done',
  'failed',
  'needs_review',
];

/** A `Resource.uri` scheme is the primary key for tool dispatch (design appendix). */
export type ResourceKind = 'code' | 'doc' | 'url' | 'term' | 'db';
export const RESOURCE_KINDS: readonly ResourceKind[] = ['code', 'doc', 'url', 'term', 'db'];

export type EdgeType = 'depends_on' | 'data';
export const EDGE_TYPES: readonly EdgeType[] = ['depends_on', 'data'];

/** The canonical edge id for a (from, to, type) triple — one source of truth so
 * producers (connect, sampleGraph) and the parser fallback never drift. */
export function edgeId(from: TaskId, to: TaskId, type: EdgeType = 'depends_on'): EdgeId {
  return `${from}~${to}~${type}`;
}

export type Resource = {
  id: ResourceId;
  kind: ResourceKind;
  /** Everything in the scheme: file:///…#L42 · https://… · term://<id> · db://… */
  uri: string;
  /** Optional override; usually inferred from the scheme. A ToolProvider id. */
  opensWith?: string;
  /** Human-readable label shown on the node chip. */
  label?: string;
};

/** An input reference: an upstream task's output, or a free-standing resource. */
export type Ref =
  | { kind: 'task-output'; taskId: TaskId; resourceId: ResourceId }
  | { kind: 'resource'; resourceId: ResourceId };

/** Who performs a task: an agent (role id / model tier) or a human. */
export type Executor =
  | { type: 'agent'; ref: string }
  | { type: 'human'; ref?: string };

/** One acceptance criterion + its (system-filled) verdict. First-class data. */
export type Criterion = {
  id: string;
  text: string;
  /** Filled by the system from evidence — not a human toggle. */
  verdict: 'unknown' | 'pass' | 'fail';
  checkedAt?: number;
  /** Points at the TrajectoryStep.id (or capture id) that produced this verdict. */
  evidenceRef?: string;
};

/** One trajectory step — id-addressable so a Criterion.evidenceRef can point at it. */
export type TrajectoryStep = {
  id: string;
  kind: 'message' | 'tool-call' | 'tool-result' | 'verdict';
  /** Human-readable summary (projected from the transcript). */
  summary: string;
  at: number;
};

export type TaskEvidence = {
  /** The id-addressable trajectory of the turn(s) that ran this task. */
  trajectory: TrajectoryStep[];
  /** Human-readable result summary. */
  result: string;
  /**
   * A unified diff the task's agent produced in an ISOLATED git worktree (never
   * applied to the live workspace) — surfaced for the user to review before
   * applying. Present only after an "implement" run.
   */
  patch?: string;
};

export type Task = {
  id: TaskId;
  title: string;
  /** Why it exists = the Goal context. */
  intent: string;
  kind: TaskKind;
  status: TaskStatus;
  executor: Executor;
  inputs: Ref[];
  outputs: Resource[];
  acceptance: Criterion[];
  evidence?: TaskEvidence;
};

export type Edge = {
  id: EdgeId;
  from: TaskId;
  to: TaskId;
  /** Directed + typed — unlike the canvas's untyped/undirected edge. */
  type: EdgeType;
};

/** A whole graph generated from one Goal. The canvas's domain model. */
export type WorkGraph = {
  id: string;
  goal: string;
  tasks: Task[];
  edges: Edge[];
  createdAt: number;
  updatedAt: number;
};

/**
 * Input to run ONE task as a real agent (electron/agent/run-task.ts, behind the
 * `workos:run-task` IPC). The acceptance texts are passed so the executing agent
 * knows what it is being judged against; verdicts themselves stay system-filled.
 */
export type RunTaskInput = {
  taskId: TaskId;
  title: string;
  intent: string;
  goal: string;
  acceptance: string[];
};

/**
 * Result of a real per-task agent run. `ok:false` means the run could not be
 * attempted (e.g. no provider connected) — the caller may fall back to a dry run;
 * `ok:true` always reflects a real attempt, with `status` 'done' or 'failed'.
 */
export type RunTaskResult =
  | {
      ok: true;
      status: Extract<TaskStatus, 'done' | 'failed'>;
      result: string;
      /** Real workspace files the agent identified as relevant (validated to exist). */
      outputs: Resource[];
    }
  | { ok: false; reason: string };

/**
 * Result of an "implement" run — the task's agent edits files in an ISOLATED git
 * worktree, the diff is captured, and the worktree is discarded (the live
 * workspace is never touched). The `patch` is surfaced for the user to review and
 * apply deliberately.
 */
export type ImplementTaskResult =
  | {
      ok: true;
      status: Extract<TaskStatus, 'done' | 'failed'>;
      result: string;
      /** Unified diff produced in the worktree (empty string if the agent made no edits). */
      patch: string;
      /** Paths the agent changed in the worktree. */
      changedFiles: string[];
    }
  | { ok: false; reason: string };

/** Input to apply a task's reviewed worktree diff to the LIVE workspace. */
/**
 * `workspaceId` (a `WorkspaceId` from shared/workspace.ts, kept as a plain string
 * here to preserve this module's zero-imports invariant) is the OPTIONAL
 * authoritative target a patch belongs to. The renderer resolves it from the
 * task's conversation thread and passes it so main can REJECT the apply when the
 * focused (active) workspace differs — a task bound to workspace B must never be
 * written into workspace A's repo (`git apply --check` only catches context drift,
 * not new-file / coincident-context hunks landing in the wrong repo). Omitted = an
 * unbound task, which targets the active workspace by definition, so the legacy
 * active-workspace behavior is preserved unchanged.
 */
export type ApplyPatchInput = { taskId: TaskId; patch: string; workspaceId?: string };

/**
 * Result of applying a task's patch to the live workspace. `ok:false` carries a
 * human reason — notably when the patch no longer applies cleanly because the live
 * tree drifted since the task was implemented; the apply is rejected, never forced.
 *
 * `verdict` is the system-verified acceptance signal (roadmap §7-4 Phase-1
 * single-verdict approximation): after the diff lands, the workspace's own checker
 * (run_diagnostics / typecheck) runs over the applied files. 'pass' = no errors,
 * 'fail' = errors, `null` = no checker applied so it stays honestly unverified.
 * Never derived from the agent's self-claim or a human toggle.
 */
export type ApplyPatchResult =
  | { ok: true; changedFiles: string[]; verdict: 'pass' | 'fail' | null }
  | { ok: false; reason: string };

/* ── type guards (specs.ts / providers.ts convention) ──────────────────────── */

export function isTaskKind(v: unknown): v is TaskKind {
  return typeof v === 'string' && (TASK_KINDS as readonly string[]).includes(v);
}
export function isTaskStatus(v: unknown): v is TaskStatus {
  return typeof v === 'string' && (TASK_STATUSES as readonly string[]).includes(v);
}
export function isResourceKind(v: unknown): v is ResourceKind {
  return typeof v === 'string' && (RESOURCE_KINDS as readonly string[]).includes(v);
}
export function isEdgeType(v: unknown): v is EdgeType {
  return typeof v === 'string' && (EDGE_TYPES as readonly string[]).includes(v);
}

/** A status the scheduler treats as "finished" (won't run / re-run). */
export function isTerminalStatus(s: TaskStatus): boolean {
  return s === 'done' || s === 'failed';
}

/* ── pure scheduler (dependency order + parallelism) ────────────────────────
 * The scheduler only follows `depends_on` edges; `data` edges express a context
 * handoff for prompts, not an execution gate. Pure + total so it can drive both
 * the renderer's status display and a main-process executor, and be unit-tested
 * without a provider. */

/** Direct upstream task ids (predecessors via `depends_on`) of `taskId`. */
export function dependenciesOf(graph: WorkGraph, taskId: TaskId): TaskId[] {
  return graph.edges
    .filter((e) => e.type === 'depends_on' && e.to === taskId)
    .map((e) => e.from);
}

/** Direct downstream task ids (successors via `depends_on`) of `taskId`. */
export function dependentsOf(graph: WorkGraph, taskId: TaskId): TaskId[] {
  return graph.edges
    .filter((e) => e.type === 'depends_on' && e.from === taskId)
    .map((e) => e.to);
}

/**
 * Tasks that are ready to run *now*: still `planned`, an agent executor (humans
 * gate manually), and every `depends_on` upstream is `done`. Edges that point at
 * a missing task are ignored (defensive — AI output / hand edits can dangle).
 */
export function readyTasks(graph: WorkGraph): Task[] {
  const byId = new Map(graph.tasks.map((t) => [t.id, t]));
  return graph.tasks.filter((t) => {
    if (t.status !== 'planned') return false;
    // A `decision` node or a `human` executor is a manual gate — the scheduler
    // never auto-runs it (the user advances it by hand). Only agent work tasks run.
    if (t.kind === 'decision' || t.executor.type !== 'agent') return false;
    return dependenciesOf(graph, t.id).every((dep) => {
      const up = byId.get(dep);
      return !up || up.status === 'done';
    });
  });
}

/**
 * Tasks transitively blocked by a `failed` upstream — surfaced so the UI marks
 * them `blocked` rather than leaving them silently `planned`. Propagates in
 * topological order so a task downstream of an already-blocked (not just
 * directly-failed) task is also blocked; falls back to array order on a cycle.
 */
export function blockedTaskIds(graph: WorkGraph): Set<TaskId> {
  const byId = new Map(graph.tasks.map((t) => [t.id, t]));
  const blocked = new Set<TaskId>();
  const order = topologicalOrder(graph) ?? graph.tasks.map((t) => t.id);
  for (const id of order) {
    const t = byId.get(id);
    if (!t || isTerminalStatus(t.status)) continue;
    const deps = dependenciesOf(graph, id);
    if (
      deps.some((d) => {
        const up = byId.get(d);
        return up?.status === 'failed' || up?.status === 'blocked' || blocked.has(d);
      })
    ) {
      blocked.add(id);
    }
  }
  return blocked;
}

/** True if the `depends_on` subgraph has a cycle (Kahn's algorithm leftover). */
export function hasCycle(graph: WorkGraph): boolean {
  return topologicalOrder(graph) === null;
}

/**
 * Build the `depends_on` adjacency for Kahn's algorithm: each task's indegree and
 * out-neighbours, skipping non-`depends_on` edges, self-loops, and edges to/from
 * unknown tasks. Shared by {@link topologicalOrder} and {@link parallelLayers}.
 */
function dependsOnAdjacency(graph: WorkGraph): {
  ids: TaskId[];
  indegree: Map<TaskId, number>;
  out: Map<TaskId, TaskId[]>;
} {
  const ids = graph.tasks.map((t) => t.id);
  const idSet = new Set(ids);
  const indegree = new Map<TaskId, number>(ids.map((id) => [id, 0]));
  const out = new Map<TaskId, TaskId[]>(ids.map((id) => [id, []]));
  for (const e of graph.edges) {
    if (e.type !== 'depends_on') continue;
    if (!idSet.has(e.from) || !idSet.has(e.to) || e.from === e.to) continue;
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
    out.get(e.from)?.push(e.to);
  }
  return { ids, indegree, out };
}

/**
 * Topological order of task ids by `depends_on` (Kahn's algorithm), or `null`
 * when a cycle exists. Stable: ties keep the tasks' array order.
 */
export function topologicalOrder(graph: WorkGraph): TaskId[] | null {
  const { ids, indegree, out } = dependsOnAdjacency(graph);
  const queue = ids.filter((id) => (indegree.get(id) ?? 0) === 0);
  const order: TaskId[] = [];
  while (queue.length) {
    const id = queue.shift() as TaskId;
    order.push(id);
    for (const next of out.get(id) ?? []) {
      const d = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  return order.length === ids.length ? order : null;
}

/**
 * Parallelism layers: each layer's tasks have no `depends_on` between them and
 * depend only on earlier layers, so a layer can run concurrently. `null` on a
 * cycle. (Independent tasks land in the same layer — the parallel-run grouping.)
 */
export function parallelLayers(graph: WorkGraph): TaskId[][] | null {
  const { ids, indegree, out } = dependsOnAdjacency(graph);
  const layers: TaskId[][] = [];
  let frontier = ids.filter((id) => (indegree.get(id) ?? 0) === 0);
  let seen = 0;
  while (frontier.length) {
    layers.push(frontier);
    seen += frontier.length;
    const next: TaskId[] = [];
    for (const id of frontier) {
      for (const dn of out.get(id) ?? []) {
        const d = (indegree.get(dn) ?? 0) - 1;
        indegree.set(dn, d);
        if (d === 0) next.push(dn);
      }
    }
    frontier = next;
  }
  return seen === ids.length ? layers : null;
}

/* ── defensive parsing (AI output / IPC / persistence) ──────────────────────
 * The decomposer's `generateText` output is `unknown` (raw JSON) until validated; mirror
 * the repo's hand-rolled guards (canvas/store.ts isNum/isStr) so a malformed
 * graph fails closed to null rather than corrupting state. */

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const rec = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;

function parseResource(raw: unknown): Resource | null {
  const r = rec(raw);
  if (!r || !isStr(r.id) || !isStr(r.uri) || !isResourceKind(r.kind)) return null;
  return {
    id: r.id,
    kind: r.kind,
    uri: r.uri,
    ...(isStr(r.opensWith) ? { opensWith: r.opensWith } : {}),
    ...(isStr(r.label) ? { label: r.label } : {}),
  };
}

function parseRef(raw: unknown): Ref | null {
  const r = rec(raw);
  if (!r) return null;
  if (r.kind === 'task-output' && isStr(r.taskId) && isStr(r.resourceId)) {
    return { kind: 'task-output', taskId: r.taskId, resourceId: r.resourceId };
  }
  if (r.kind === 'resource' && isStr(r.resourceId)) {
    return { kind: 'resource', resourceId: r.resourceId };
  }
  return null;
}

function parseExecutor(raw: unknown): Executor {
  const r = rec(raw);
  if (r?.type === 'human') return { type: 'human', ...(isStr(r.ref) ? { ref: r.ref } : {}) };
  if (r && r.type === 'agent' && isStr(r.ref)) return { type: 'agent', ref: r.ref };
  // Default executor: the general agent role (decompose may omit it).
  return { type: 'agent', ref: 'agent' };
}

function parseCriterion(raw: unknown): Criterion | null {
  const r = rec(raw);
  if (!r || !isStr(r.id) || !isStr(r.text)) return null;
  const verdict = r.verdict === 'pass' || r.verdict === 'fail' ? r.verdict : 'unknown';
  return {
    id: r.id,
    text: r.text,
    verdict,
    ...(isNum(r.checkedAt) ? { checkedAt: r.checkedAt } : {}),
    ...(isStr(r.evidenceRef) ? { evidenceRef: r.evidenceRef } : {}),
  };
}

function parseTask(raw: unknown): Task | null {
  const r = rec(raw);
  if (!r || !isStr(r.id) || !isStr(r.title)) return null;
  return {
    id: r.id,
    title: r.title,
    intent: isStr(r.intent) ? r.intent : '',
    kind: isTaskKind(r.kind) ? r.kind : 'work',
    status: isTaskStatus(r.status) ? r.status : 'planned',
    executor: parseExecutor(r.executor),
    inputs: Array.isArray(r.inputs) ? r.inputs.map(parseRef).filter((x): x is Ref => !!x) : [],
    outputs: Array.isArray(r.outputs)
      ? r.outputs.map(parseResource).filter((x): x is Resource => !!x)
      : [],
    acceptance: Array.isArray(r.acceptance)
      ? r.acceptance.map(parseCriterion).filter((x): x is Criterion => !!x)
      : [],
  };
}

function parseEdge(raw: unknown, taskIds: Set<TaskId>): Edge | null {
  const r = rec(raw);
  if (!r || !isStr(r.from) || !isStr(r.to) || r.from === r.to) return null;
  if (!taskIds.has(r.from) || !taskIds.has(r.to)) return null;
  const type: EdgeType = isEdgeType(r.type) ? r.type : 'depends_on';
  return { id: isStr(r.id) ? r.id : edgeId(r.from, r.to, type), from: r.from, to: r.to, type };
}

/**
 * Validate an unknown value (LLM output / persisted blob) into a {@link WorkGraph},
 * dropping malformed tasks/edges, de-duping edges, and rejecting graphs that are
 * empty or cyclic. Returns null on anything unusable.
 */
export function parseWorkGraph(raw: unknown): WorkGraph | null {
  const r = rec(raw);
  if (!r) return null;
  const tasks = Array.isArray(r.tasks)
    ? r.tasks.map(parseTask).filter((t): t is Task => !!t)
    : [];
  if (tasks.length === 0) return null;
  // De-dupe tasks by id (first wins).
  const seen = new Set<TaskId>();
  const uniqueTasks = tasks.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
  const taskIds = new Set(uniqueTasks.map((t) => t.id));
  const edgeSeen = new Set<string>();
  const edges = (Array.isArray(r.edges) ? r.edges : [])
    .map((e) => parseEdge(e, taskIds))
    .filter((e): e is Edge => !!e)
    .filter((e) => (edgeSeen.has(e.id) ? false : (edgeSeen.add(e.id), true)));
  const graph: WorkGraph = {
    id: isStr(r.id) ? r.id : `wg_${Date.now().toString(36)}`,
    goal: isStr(r.goal) ? r.goal : '',
    tasks: uniqueTasks,
    edges,
    createdAt: isNum(r.createdAt) ? r.createdAt : Date.now(),
    updatedAt: isNum(r.updatedAt) ? r.updatedAt : Date.now(),
  };
  return hasCycle(graph) ? null : graph;
}
