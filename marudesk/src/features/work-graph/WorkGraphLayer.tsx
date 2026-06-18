import { memo, useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Check, Play, Plus, Square, Trash2, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import {
  type Task,
  type TaskStatus,
  type WorkGraph,
} from '../../../shared/work-os';
import { toast } from '../../lib/toast';
import { sampleGraph, useWorkGraphStore } from './store';

export const NODE_W = 208;
export const NODE_H = 118;

/** Token-only status styling (success/warning/error/accent — tailwind.config.ts). */
const STATUS_STYLE: Record<TaskStatus, { ring: string; chip: string; label: string }> = {
  planned: { ring: 'border-subtle', chip: 'bg-surface-3 text-fg-tertiary', label: 'Planned' },
  running: { ring: 'border-accent', chip: 'bg-accent-subtle text-accent', label: 'Running' },
  blocked: { ring: 'border-warning', chip: 'bg-warning-subtle text-warning', label: 'Blocked' },
  done: { ring: 'border-success', chip: 'bg-success-subtle text-success', label: 'Done' },
  failed: { ring: 'border-error', chip: 'bg-error-subtle text-error', label: 'Failed' },
  needs_review: { ring: 'border-warning', chip: 'bg-warning-subtle text-warning', label: 'Review' },
};

type Props = {
  /** Screen px → canvas coords (CanvasStage owns the transform). */
  toCanvas: (clientX: number, clientY: number) => { x: number; y: number };
  /** Current canvas zoom (drag deltas are screen px → divide by scale). */
  scale: number;
};

/**
 * Task nodes + directed `depends_on` edges drawn inside the canvas plane (Maru's
 * AI Work OS — docs/ai-work-os-roadmap.md Phase 1). Rendered alongside the tool
 * cards; positions are keyed by `Task.id` in {@link useWorkGraphStore}, never a
 * tab id. Pointer handlers stop propagation so node drags don't pan/marquee the
 * canvas.
 */
export function WorkGraphNodes({ toCanvas, scale }: Props) {
  const graph = useWorkGraphStore((s) => s.graph);
  const pos = useWorkGraphStore((s) => s.pos);
  const selectedTaskId = useWorkGraphStore((s) => s.selectedTaskId);
  // Live connection drag (from a node's output port), in canvas coords, or null.
  const [connect, setConnect] = useState<{ from: string; x: number; y: number } | null>(null);

  const startConnect = useCallback(
    (fromId: string, clientX: number, clientY: number) => {
      const p = toCanvas(clientX, clientY);
      setConnect({ from: fromId, x: p.x, y: p.y });
      const onMove = (ev: PointerEvent) => {
        const q = toCanvas(ev.clientX, ev.clientY);
        setConnect((c) => (c ? { ...c, x: q.x, y: q.y } : c));
      };
      const onUp = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        setConnect(null);
        const pt = toCanvas(ev.clientX, ev.clientY);
        const positions = useWorkGraphStore.getState().pos;
        // Hit-test which node the loose end was dropped on (canvas-space rect).
        for (const [id, np] of Object.entries(positions)) {
          if (id === fromId) continue;
          if (pt.x >= np.x && pt.x <= np.x + NODE_W && pt.y >= np.y && pt.y <= np.y + NODE_H) {
            const r = useWorkGraphStore.getState().connect(fromId, id);
            if (!r.ok) {
              toast({
                title: r.reason === 'cycle' ? 'Would create a cycle' : r.reason === 'duplicate' ? 'Already connected' : 'Cannot connect a task to itself',
                variant: 'warning',
              });
            }
            break;
          }
        }
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [toCanvas],
  );

  if (!graph) return null;

  return (
    <>
      <WorkGraphEdges graph={graph} pos={pos} connect={connect} />
      {graph.tasks.map((task) => {
        const p = pos[task.id];
        if (!p) return null;
        return (
          <TaskNodeCard
            key={task.id}
            task={task}
            x={p.x}
            y={p.y}
            scale={scale}
            selected={selectedTaskId === task.id}
            taskId={task.id}
            onStartConnect={startConnect}
          />
        );
      })}
    </>
  );
}

/** Directed depends_on edges (SVG, arrowheads), drawn behind the task nodes. */
function WorkGraphEdges({
  graph,
  pos,
  connect,
}: {
  graph: WorkGraph;
  pos: Record<string, { x: number; y: number }>;
  connect: { from: string; x: number; y: number } | null;
}) {
  const center = (id: string) => {
    const p = pos[id];
    return p ? { x: p.x + NODE_W / 2, y: p.y + NODE_H / 2 } : null;
  };
  const lines = graph.edges
    .filter((e) => e.type === 'depends_on')
    .map((e) => ({ e, a: center(e.from), b: center(e.to) }))
    .filter((l): l is { e: typeof l.e; a: { x: number; y: number }; b: { x: number; y: number } } => !!l.a && !!l.b);
  const live = connect ? center(connect.from) : null;
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute left-0 top-0 overflow-visible"
      style={{ width: 1, height: 1 }}
    >
      <defs>
        <marker id="wg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="var(--accent)" />
        </marker>
      </defs>
      {lines.map(({ e, a, b }) => (
        <line
          key={e.id}
          x1={a.x}
          y1={a.y}
          x2={b.x}
          y2={b.y}
          stroke="var(--accent)"
          strokeWidth={1.5}
          markerEnd="url(#wg-arrow)"
          opacity={0.65}
        />
      ))}
      {live && connect ? (
        <line x1={live.x} y1={live.y} x2={connect.x} y2={connect.y} stroke="var(--accent)" strokeWidth={1.5} strokeDasharray="4 4" />
      ) : null}
    </svg>
  );
}

const TaskNodeCard = memo(function TaskNodeCard({
  task,
  x,
  y,
  scale,
  selected,
  taskId,
  onStartConnect,
}: {
  task: Task;
  x: number;
  y: number;
  scale: number;
  selected: boolean;
  taskId: string;
  onStartConnect: (fromId: string, clientX: number, clientY: number) => void;
}) {
  const dragRef = useRef<{ pointerId: number; sx: number; sy: number; ox: number; oy: number } | null>(null);
  const style = STATUS_STYLE[task.status];
  const passed = task.acceptance.filter((c) => c.verdict === 'pass').length;
  const failed = task.acceptance.filter((c) => c.verdict === 'fail').length;

  const onHeaderDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    useWorkGraphStore.getState().selectTask(task.id);
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, ox: x, oy: y };
  };
  const onHeaderMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    e.stopPropagation();
    useWorkGraphStore.getState().setPos(task.id, d.ox + (e.clientX - d.sx) / scale, d.oy + (e.clientY - d.sy) / scale);
  };
  const onHeaderUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === e.pointerId) dragRef.current = null;
  };

  return (
    <div
      data-task-node={task.id}
      tabIndex={0}
      role="group"
      aria-label={`${style.label} task: ${task.title}`}
      className={cn(
        'absolute rounded-lg border bg-surface-1 bg-surface-gradient shadow-card select-none focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        style.ring,
        selected ? 'ring-2 ring-accent' : '',
      )}
      style={{ left: x, top: y, width: NODE_W, minHeight: NODE_H }}
      onFocus={() => useWorkGraphStore.getState().selectTask(task.id)}
      onPointerDown={(e) => {
        e.stopPropagation();
        useWorkGraphStore.getState().selectTask(task.id);
      }}
      onKeyDown={(e) => {
        const STEP = 8;
        switch (e.key) {
          case 'ArrowLeft':
            e.preventDefault();
            useWorkGraphStore.getState().setPos(task.id, x - STEP, y);
            break;
          case 'ArrowRight':
            e.preventDefault();
            useWorkGraphStore.getState().setPos(task.id, x + STEP, y);
            break;
          case 'ArrowUp':
            e.preventDefault();
            useWorkGraphStore.getState().setPos(task.id, x, y - STEP);
            break;
          case 'ArrowDown':
            e.preventDefault();
            useWorkGraphStore.getState().setPos(task.id, x, y + STEP);
            break;
          case 'Delete':
          case 'Backspace':
            useWorkGraphStore.getState().deleteTask(task.id);
            break;
        }
      }}
    >
      {/* Drag header */}
      <div
        data-task-header
        onPointerDown={onHeaderDown}
        onPointerMove={onHeaderMove}
        onPointerUp={onHeaderUp}
        onPointerCancel={onHeaderUp}
        className="flex items-center gap-1.5 px-2.5 pt-2 pb-1 cursor-grab active:cursor-grabbing"
      >
        <span className={cn('rounded-pill px-1.5 py-0.5 text-[10px] font-medium leading-none', style.chip)}>
          {style.label}
        </span>
        {task.kind === 'decision' ? (
          <span className="rounded-pill bg-surface-3 px-1.5 py-0.5 text-[10px] text-fg-tertiary leading-none">Decision</span>
        ) : null}
        <span className="ml-auto" />
        {selected ? (
          <button
            type="button"
            aria-label="Delete task"
            title="Delete task"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => useWorkGraphStore.getState().deleteTask(task.id)}
            className="grid h-5 w-5 place-items-center rounded text-fg-tertiary hover:bg-error-subtle hover:text-error"
          >
            <X size={12} />
          </button>
        ) : null}
      </div>

      {/* Body */}
      <div className="px-2.5 pb-2.5">
        <button
          type="button"
          title="Cycle status"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => useWorkGraphStore.getState().updateTask(task.id, { status: nextStatus(task.status) })}
          className="block w-full text-left text-body-sm font-medium text-fg-primary truncate hover:text-accent"
        >
          {task.title}
        </button>
        {task.intent ? <p className="mt-0.5 line-clamp-2 text-caption text-fg-tertiary">{task.intent}</p> : null}
        <div className="mt-1.5 flex items-center gap-2 text-caption text-fg-tertiary">
          <span className="truncate">
            {task.executor.type === 'agent' ? `@${task.executor.ref}` : 'human'}
          </span>
          {task.acceptance.length > 0 ? (
            <span
              className={cn(
                'ml-auto tabular-nums',
                failed > 0 ? 'text-error' : passed === task.acceptance.length ? 'text-success' : 'text-fg-tertiary',
              )}
            >
              {passed}/{task.acceptance.length} ✓
            </span>
          ) : null}
        </div>
      </div>

      {/* Output port (drag to another node to add a depends_on edge) */}
      <button
        type="button"
        aria-label="Connect dependency"
        title="Drag to a downstream task"
        onPointerDown={(e) => {
          e.stopPropagation();
          e.preventDefault();
          onStartConnect(taskId, e.clientX, e.clientY);
        }}
        className="absolute -bottom-2 left-1/2 -translate-x-1/2 grid h-4 w-4 place-items-center rounded-pill border border-default bg-surface-2 text-fg-tertiary hover:border-accent hover:text-accent"
      >
        <span className="block h-1.5 w-1.5 rounded-pill bg-current" />
      </button>
    </div>
  );
});

/** Human status cycle for manual edits (planned → done → failed → needs_review → planned). */
function nextStatus(s: TaskStatus): TaskStatus {
  /** Excludes 'running' — that status is scheduler-owned; manual cycle is planned → done → failed → needs_review. */
  const cycle: TaskStatus[] = ['planned', 'done', 'failed', 'needs_review'];
  const i = cycle.indexOf(s);
  // If current status is scheduler-owned ('running'/'blocked'), indexOf returns -1 → ((-1+1)%4 = 0) → 'planned'.
  return cycle[(i + 1) % cycle.length];
}

/**
 * Screen-fixed Work-OS controls: a goal input that generates a Task graph, plus
 * Run (dependency-ordered simulate) / Add task / Clear. Rendered as a WorkGraphStage
 * overlay (sibling of the transformed node plane).
 */
export function WorkGraphPanel() {
  const graph = useWorkGraphStore((s) => s.graph);
  const running = useWorkGraphStore((s) => s.running);
  const runNote = useWorkGraphStore((s) => s.runNote);
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Try the AI decomposer; fall back to a deterministic offline sample so the
  // loop always works without a configured provider (and explain why).
  const generate = async () => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await window.marudesk.invoke('workos:decompose', goal);
      if (res.ok) {
        useWorkGraphStore.getState().setGraph(res.graph);
      } else {
        useWorkGraphStore.getState().setGraph(sampleGraph(goal));
        setNotice(`Offline sample — ${res.reason}`);
      }
    } catch {
      useWorkGraphStore.getState().setGraph(sampleGraph(goal));
      setNotice('Offline sample — AI was unavailable.');
    } finally {
      setBusy(false);
    }
  };

  const summary = graph
    ? `${graph.tasks.length} tasks · ${graph.tasks.filter((t) => t.status === 'done').length} done`
    : 'No graph yet';

  return (
    <div className="absolute left-3 top-14 z-50 w-72 rounded-lg chrome-panel p-2.5 shadow-card">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-caption font-medium text-fg-secondary">AI Task graph</span>
      </div>
      <div className="flex gap-1.5">
        <input
          value={goal}
          onChange={(e) => setGoal(e.currentTarget.value)}
          placeholder="Describe a goal…"
          onKeyDown={(e) => {
            if (e.key === 'Enter') void generate();
          }}
          className="h-8 min-w-0 flex-1 rounded-md bg-surface-2 border border-subtle px-2 text-body-sm text-fg-primary placeholder:text-fg-tertiary focus:outline-none focus:border-accent"
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => void generate()}
          className="h-8 shrink-0 rounded-md bg-accent px-2.5 text-body-sm font-medium text-white hover:bg-accent-hover disabled:opacity-60"
        >
          {busy ? 'Generating…' : 'Generate'}
        </button>
      </div>
      {notice ? <p className="mt-1.5 text-caption text-warning">{notice}</p> : null}
      <div className="mt-2 flex items-center gap-1.5">
        <button
          type="button"
          disabled={!graph}
          title={
            running
              ? 'Stop the run'
              : 'Run — executes each ready task as an agent (falls back to a dry run if no provider is connected)'
          }
          onClick={() => (running ? useWorkGraphStore.getState().stopRun() : void useWorkGraphStore.getState().run())}
          className="inline-flex h-7 items-center gap-1 rounded-md bg-surface-2 px-2 text-caption text-fg-secondary hover:text-fg-primary hover:bg-surface-3 disabled:opacity-50"
        >
          {running ? <Square size={12} /> : <Play size={12} />}
          {running ? 'Stop' : 'Run'}
        </button>
        <button
          type="button"
          disabled={running}
          onClick={() => useWorkGraphStore.getState().addTask()}
          className="inline-flex h-7 items-center gap-1 rounded-md bg-surface-2 px-2 text-caption text-fg-secondary hover:text-fg-primary hover:bg-surface-3 disabled:opacity-50"
        >
          <Plus size={12} />
          Task
        </button>
        <button
          type="button"
          disabled={!graph || running}
          onClick={() => useWorkGraphStore.getState().resetRun()}
          className="inline-flex h-7 items-center gap-1 rounded-md bg-surface-2 px-2 text-caption text-fg-secondary hover:text-fg-primary hover:bg-surface-3 disabled:opacity-50"
        >
          <Check size={12} />
          Reset
        </button>
        <button
          type="button"
          disabled={!graph || running}
          onClick={() => useWorkGraphStore.getState().clearGraph()}
          className="ml-auto inline-flex h-7 items-center gap-1 rounded-md px-2 text-caption text-fg-tertiary hover:bg-error-subtle hover:text-error disabled:opacity-50"
        >
          <Trash2 size={12} />
        </button>
      </div>
      <p className="mt-1.5 text-caption text-fg-tertiary">{summary}</p>
      {runNote ? <p className="mt-1 text-caption text-warning">{runNote}</p> : null}
    </div>
  );
}
