import { memo, useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Check, Play, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import { Spinner } from '../../components/ui';
import { cn } from '../../lib/cn';
import {
  type Task,
  type TaskId,
  type TaskStatus,
  type WorkGraph,
} from '../../../shared/work-os';
import { useI18n } from '../../i18n/useI18n';
import { toast } from '../../lib/toast';
import { sampleGraph, useWorkGraphStore } from './store';
import { STATUS_LABEL_KEY } from './status';

export const NODE_W = 208;
export const NODE_H = 118;

/** Token-only status styling (success/warning/error/accent — tailwind.config.ts). */
const STATUS_STYLE: Record<TaskStatus, { ring: string; chip: string }> = {
  planned: { ring: 'border-default', chip: 'bg-surface-3 text-fg-tertiary' },
  running: { ring: 'border-accent', chip: 'bg-accent-subtle text-accent' },
  blocked: { ring: 'border-warning', chip: 'bg-warning-subtle text-warning' },
  done: { ring: 'border-success', chip: 'bg-success-subtle text-success' },
  failed: { ring: 'border-error', chip: 'bg-error-subtle text-error' },
  needs_review: { ring: 'border-warning', chip: 'bg-warning-subtle text-warning' },
};

type Props = {
  /** Screen px → canvas coords (CanvasStage owns the transform). */
  toCanvas: (clientX: number, clientY: number) => { x: number; y: number };
  /**
   * Live canvas zoom as a stable getter (drag deltas are screen px → divide by
   * scale). Passed as a getter rather than a `scale` value so a zoom change does
   * not re-render every memoized TaskNodeCard, and so node callback identity
   * stays stable across pan/zoom.
   */
  getScale: () => number;
};

/**
 * Task nodes + directed `depends_on` edges drawn inside the canvas plane (Maru's
 * AI Work OS — docs/ai-work-os-roadmap.md Phase 1). Rendered alongside the tool
 * cards; positions are keyed by `Task.id` in {@link useWorkGraphStore}, never a
 * tab id. Pointer handlers stop propagation so node drags don't pan/marquee the
 * canvas.
 */
export function WorkGraphNodes({ toCanvas, getScale }: Props) {
  const { t } = useI18n();
  const graph = useWorkGraphStore((s) => s.graph);
  const graphId = useWorkGraphStore((s) => s.graph?.id);
  const pos = useWorkGraphStore((s) => s.pos);
  const selectedTaskId = useWorkGraphStore((s) => s.selectedTaskId);
  // Live connection drag (from a node's output port), in canvas coords, or null.
  const [connect, setConnect] = useState<{ from: string; x: number; y: number } | null>(null);
  // Keyboard connect: the armed source task awaiting a target (Enter on a second
  // node completes the edge). Null when not arming. Distinct from `connect`, which
  // is the pointer-drag loose end — a keyboard user never produces a loose end.
  // The ref mirrors the state so the (stable) keyboard handlers can read the armed
  // source synchronously, WITHOUT running store mutations inside a setState updater
  // (that updater is double-invoked under StrictMode and would connect twice).
  const [pendingConnectFrom, setPendingConnectFrom] = useState<TaskId | null>(null);
  const pendingConnectFromRef = useRef<TaskId | null>(null);
  const setPending = useCallback((next: TaskId | null) => {
    pendingConnectFromRef.current = next;
    setPendingConnectFrom(next);
  }, []);

  // Surface the same connect-failure toast for both pointer-drag and keyboard
  // connects. Stable identity (depends only on `t`) so it never busts the
  // round-23 TaskNodeCard memo.
  const toastConnectFailure = useCallback(
    (reason: 'self' | 'duplicate' | 'cycle') => {
      toast({
        title:
          reason === 'cycle'
            ? t('workGraph.connect.cycle')
            : reason === 'duplicate'
              ? t('workGraph.connect.duplicate')
              : t('workGraph.connect.self'),
        variant: 'warning',
      });
    },
    [t],
  );

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
            if (!r.ok) toastConnectFailure(r.reason);
            break;
          }
        }
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [toCanvas, toastConnectFailure],
  );

  // Keyboard: arm a task's output port as the connect source (Enter/Space on the
  // port). Stable identity — the per-node `isPendingSource` boolean is what each
  // card consumes, so toggling the source does not re-render unrelated cards.
  const armConnect = useCallback(
    (fromId: TaskId) => {
      setPending(fromId);
    },
    [setPending],
  );

  // Keyboard: complete a connect from a focused node. Enter on a DIFFERENT node
  // than the armed source creates the edge (same failure toast as the drag path).
  // Reads the armed source from the ref (no setState side-effect) and returns true
  // when a source was armed so the node handler consumes the key; false lets Enter
  // fall through to the title button.
  const completeConnect = useCallback(
    (toId: TaskId): boolean => {
      const from = pendingConnectFromRef.current;
      if (from === null) return false;
      setPending(null);
      if (from === toId) return true; // same node — just disarm
      const r = useWorkGraphStore.getState().connect(from, toId);
      if (!r.ok) toastConnectFailure(r.reason);
      return true;
    },
    [setPending, toastConnectFailure],
  );

  const cancelConnect = useCallback(() => {
    setPending(null);
  }, [setPending]);

  // Keyboard: remove a focused node's last incoming `depends_on` edge (the most
  // recently added dependency) via the existing store action — the keyboard
  // counterpart to deleting an edge. No-op when the node has no dependencies.
  const removeIncomingEdge = useCallback((toId: TaskId): boolean => {
    const g = useWorkGraphStore.getState().graph;
    if (!g) return false;
    const incoming = g.edges.filter((e) => e.type === 'depends_on' && e.to === toId);
    const last = incoming[incoming.length - 1];
    if (!last) return false;
    useWorkGraphStore.getState().removeEdge(last.id);
    return true;
  }, []);

  if (!graph) return null;

  return (
    <>
      <WorkGraphEdges graph={graph} pos={pos} connect={connect} />
      {graph.tasks.map((task, index) => {
        const p = pos[task.id];
        if (!p) return null;
        return (
          <TaskNodeCard
            key={`${graphId}-${task.id}`}
            task={task}
            x={p.x}
            y={p.y}
            getScale={getScale}
            selected={selectedTaskId === task.id}
            taskId={task.id}
            onStartConnect={startConnect}
            isPendingSource={pendingConnectFrom === task.id}
            onArmConnect={armConnect}
            onCompleteConnect={completeConnect}
            onCancelConnect={cancelConnect}
            onRemoveIncomingEdge={removeIncomingEdge}
            entranceDelayMs={Math.min(index, 6) * 40}
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
      className="pointer-events-none absolute left-0 top-0 overflow-visible motion-safe:animate-fade-rise"
      style={{ width: 1, height: 1 }}
    >
      <defs>
        <marker id="wg-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="var(--accent)" fillOpacity={0.65} />
        </marker>
      </defs>
      {lines.map(({ e, a, b }) => {
        const sx = a.x;
        const sy = a.y + NODE_H / 2;
        const tx = b.x;
        const ty = b.y - NODE_H / 2;
        const ctrlOffset = Math.max(48, Math.abs(ty - sy) * 0.45);
        return (
          <path
            key={e.id}
            d={`M ${sx},${sy} C ${sx},${sy + ctrlOffset} ${tx},${ty - ctrlOffset} ${tx},${ty}`}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={1.5}
            markerEnd="url(#wg-arrow)"
            opacity={0.65}
          />
        );
      })}
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
  getScale,
  selected,
  taskId,
  onStartConnect,
  isPendingSource,
  onArmConnect,
  onCompleteConnect,
  onCancelConnect,
  onRemoveIncomingEdge,
  entranceDelayMs,
}: {
  task: Task;
  x: number;
  y: number;
  getScale: () => number;
  selected: boolean;
  taskId: TaskId;
  onStartConnect: (fromId: string, clientX: number, clientY: number) => void;
  /** This node is the armed keyboard-connect source (awaiting a target). */
  isPendingSource: boolean;
  onArmConnect: (fromId: TaskId) => void;
  /**
   * Complete a keyboard-connect with this node as target. Returns true when a
   * source was armed (so the key is consumed); false when nothing was armed (the
   * caller lets Enter fall through). Cheap no-op when not armed, so every node can
   * call it unconditionally — no global "is arming" flag has to be threaded
   * through the memo, keeping unrelated cards from re-rendering on arm/disarm.
   */
  onCompleteConnect: (toId: TaskId) => boolean;
  onCancelConnect: () => void;
  /** Returns true when an incoming edge was removed (key consumed). */
  onRemoveIncomingEdge: (toId: TaskId) => boolean;
  entranceDelayMs: number;
}) {
  const { t } = useI18n();
  const dragRef = useRef<{ pointerId: number; sx: number; sy: number; ox: number; oy: number } | null>(null);
  const style = STATUS_STYLE[task.status];
  const statusLabel = t(STATUS_LABEL_KEY[task.status]);
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
    const scale = getScale();
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
      aria-label={t('workGraph.node.ariaLabel').replace('{status}', statusLabel).replace('{title}', task.title)}
      className={cn(
        'absolute rounded-lg border bg-surface-2 bg-surface-gradient shadow-card select-none focus:outline-none focus-visible:outline-none motion-safe:animate-fade-rise transition-colors transition-transform duration-fast active:scale-[0.99]',
        style.ring,
        // Armed keyboard-connect source: a token accent ring so the user sees
        // which node Enter-on-another-node will connect from (no string needed).
        isPendingSource
          ? 'border-accent shadow-[0_0_0_2px_var(--accent)]'
          : selected
            ? 'border-accent shadow-[0_0_0_2px_var(--accent-subtle)]'
            : 'hover:border-default focus-visible:shadow-[0_0_0_2px_var(--surface-page),0_0_0_4px_var(--accent)]',
      )}
      style={{ left: x, top: y, width: NODE_W, minHeight: NODE_H, animationDelay: `${entranceDelayMs}ms` }}
      onFocus={() => useWorkGraphStore.getState().selectTask(task.id)}
      onPointerDown={(e) => {
        e.stopPropagation();
        useWorkGraphStore.getState().selectTask(task.id);
      }}
      onKeyDown={(e) => {
        const STEP = 8;
        // Escape cancels any armed keyboard-connect (cheap no-op when none armed).
        if (e.key === 'Escape') {
          onCancelConnect();
          return;
        }
        // Enter completes a keyboard-connect when a source is armed (this node
        // becomes the target). onCompleteConnect returns false when nothing is
        // armed, so Enter then falls through (the body title button owns Enter for
        // status cycling, not the node group).
        if (e.key === 'Enter') {
          if (onCompleteConnect(task.id)) {
            e.preventDefault();
            return;
          }
        }
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
            // Shift removes the node's last incoming dependency edge (keyboard
            // counterpart to the pointer connect); plain deletes the task.
            if (e.shiftKey) {
              if (onRemoveIncomingEdge(task.id)) e.preventDefault();
            } else {
              useWorkGraphStore.getState().deleteTask(task.id);
            }
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
        <span className={cn('rounded-pill px-1.5 py-0.5 text-caption font-medium leading-none transition-colors duration-standard', style.chip, task.status === 'running' && 'inline-flex items-center gap-0.5')}>
          {task.status === 'running' && <Spinner size={10} label={t('workGraph.node.running')} className="-ml-0.5" />}{statusLabel}
        </span>
        {task.kind === 'decision' ? (
          <span className="rounded-pill bg-surface-3 px-1.5 py-0.5 text-caption font-medium text-fg-tertiary leading-none">{t('workGraph.node.decision')}</span>
        ) : null}
        <span className="ml-auto" />
        {selected ? (
          <button
            type="button"
            aria-label={t('workGraph.node.deleteTask')}
            title={t('workGraph.node.deleteTask')}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => useWorkGraphStore.getState().deleteTask(task.id)}
            className="grid h-5 w-5 place-items-center rounded text-fg-tertiary hover:bg-error-subtle hover:text-error focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none transition-colors duration-fast active:scale-[0.99]"
          >
            <X size={12} />
          </button>
        ) : null}
      </div>

      {/* Body */}
      <div className="px-2.5 pb-2.5">
        <button
          type="button"
          title={t('workGraph.node.cycleStatusTitle')}
          onPointerDown={(e) => e.stopPropagation()}
          // Keep Enter on the title as "cycle status": don't let it bubble to the
          // node group's keydown, which would complete an armed keyboard-connect
          // instead of cycling (the port button guards the same way).
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.stopPropagation();
          }}
          onClick={() => useWorkGraphStore.getState().updateTask(task.id, { status: nextStatus(task.status) })}
          className="block w-full text-left text-body-sm font-medium text-fg-primary truncate rounded px-2 py-1 hover:bg-surface-3 hover:underline decoration-fg-tertiary decoration-dashed underline-offset-2 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none transition-colors duration-fast"
        >
          {task.title}
        </button>
        {task.intent ? <p className="mt-1.5 line-clamp-2 text-caption text-fg-tertiary">{task.intent}</p> : null}
        <div className="mt-1.5 flex items-center gap-2 text-caption text-fg-tertiary">
          <span className="truncate">
            {task.executor.type === 'agent' ? `@${task.executor.ref}` : t('workGraph.inspector.executorHuman')}
          </span>
          {task.acceptance.length > 0 ? (
            <span
              className={cn(
                'ml-auto inline-flex items-center gap-0.5 tabular-nums',
                failed > 0 ? 'text-error' : passed === task.acceptance.length ? 'text-success' : 'text-fg-tertiary',
              )}
            >
              {passed}/{task.acceptance.length}<Check size={10} className="shrink-0" />
            </span>
          ) : null}
        </div>
      </div>

      {/* Output port: drag (pointer) OR Enter/Space (keyboard) to start a
          depends_on edge; `aria-pressed` reflects the armed keyboard state with
          no new string, and the existing connect label/title stay in locale. */}
      <button
        type="button"
        aria-label={t('workGraph.node.connectLabel')}
        title={t('workGraph.node.connectTitle')}
        aria-pressed={isPendingSource}
        onPointerDown={(e) => {
          e.stopPropagation();
          e.preventDefault();
          onStartConnect(taskId, e.clientX, e.clientY);
        }}
        onKeyDown={(e) => {
          // Enter/Space arms this node as the keyboard-connect source; the user
          // then presses Enter on the target node. stopPropagation keeps the key
          // off the node group's move/delete handler.
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
            e.preventDefault();
            e.stopPropagation();
            onArmConnect(taskId);
          }
        }}
        className={cn(
          'absolute -bottom-2 left-1/2 -translate-x-1/2 grid h-4 w-4 place-items-center rounded-pill border bg-surface-2 group cursor-grab active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none transition-colors duration-fast active:scale-[0.99]',
          isPendingSource
            ? 'border-accent text-accent shadow-[0_0_0_2px_var(--accent-subtle)]'
            : 'border-default text-fg-tertiary hover:border-accent hover:text-accent',
        )}
      >
        <span className="block h-2 w-2 rounded-pill bg-current transition-transform duration-fast group-hover:scale-125" />
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
  const { t } = useI18n();
  const graph = useWorkGraphStore((s) => s.graph);
  const running = useWorkGraphStore((s) => s.running);
  const runNote = useWorkGraphStore((s) => s.runNote);
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Focus the goal field once on mount when the surface opens empty (read the
    // store directly so the one-shot effect needs no `graph` dependency).
    if (!useWorkGraphStore.getState().graph) inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!confirmClear) return;
    const id = setTimeout(() => setConfirmClear(false), 3000);
    return () => clearTimeout(id);
  }, [confirmClear]);

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
        setNotice(t('workGraph.offlineSample').replace('{reason}', res.reason));
      }
    } catch {
      useWorkGraphStore.getState().setGraph(sampleGraph(goal));
      setNotice(t('workGraph.offlineSampleUnavailable'));
    } finally {
      setBusy(false);
    }
  };

  const summary = graph
    ? t('workGraph.summary')
        .replace('{total}', String(graph.tasks.length))
        .replace('{done}', String(graph.tasks.filter((task) => task.status === 'done').length))
    : t('workGraph.summaryEmpty');

  return (
    <div data-tour="goal" className="absolute left-3 top-14 z-50 w-72 max-h-[calc(100%-7rem)] overflow-y-auto rounded-lg chrome-panel p-2.5 shadow-card animate-scale-in">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-caption font-medium text-fg-secondary">{t('workGraph.goal')}</span>
      </div>
      <div className="flex gap-1.5">
        <input
          ref={inputRef}
          value={goal}
          onChange={(e) => setGoal(e.currentTarget.value)}
          placeholder={t('workGraph.goalPlaceholder')}
          aria-label={t('workGraph.goal')}
          title={t('workGraph.goalTitle')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && goal.trim().length > 0) void generate();
          }}
          className="h-8 min-w-0 flex-1 rounded bg-surface-2 border border-subtle px-2 text-body-sm text-fg-primary placeholder:text-fg-tertiary focus:outline-none focus:border-accent focus:shadow-focus-accent transition-shadow duration-fast"
        />
        <button
          type="button"
          disabled={busy || goal.trim().length === 0}
          onClick={() => void generate()}
          className="inline-flex items-center gap-1.5 h-8 shrink-0 rounded bg-accent px-2.5 text-body-sm font-medium text-white hover:bg-accent-hover disabled:opacity-60 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none active:scale-[0.99] transition-colors duration-fast"
        >
          {busy && <Spinner size={14} label={t('workGraph.generating')} />}{t('workGraph.generate')}
        </button>
      </div>
      {notice ? <p className="mt-1.5 text-caption text-warning">{notice}</p> : null}
      <div className="mt-2 flex items-center gap-1.5">
        <button
          type="button"
          disabled={!graph}
          title={running ? t('workGraph.stopTitle') : t('workGraph.runTitle')}
          onClick={() => (running ? useWorkGraphStore.getState().stopRun() : void useWorkGraphStore.getState().run())}
          className={
            running
              ? 'inline-flex h-7 items-center gap-1 rounded bg-surface-2 border border-default px-2.5 text-caption text-fg-primary hover:bg-surface-3 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none transition-colors duration-fast active:scale-[0.99]'
              : 'inline-flex h-7 items-center gap-1 rounded bg-accent px-2.5 text-caption font-medium text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none transition-colors duration-fast active:scale-[0.99]'
          }
        >
          {running ? <Spinner size={12} label={t('workGraph.runInProgress')} /> : <Play size={12} />}
          {running ? t('workGraph.stop') : t('workGraph.run')}
        </button>
        <button
          type="button"
          disabled={running}
          onClick={() => useWorkGraphStore.getState().addTask()}
          className="inline-flex h-7 items-center gap-1 rounded-md bg-surface-2 px-2 text-caption text-fg-secondary hover:text-fg-primary hover:bg-surface-3 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none transition-colors duration-fast active:scale-[0.99]"
        >
          <Plus size={12} />
          {t('workGraph.addTask')}
        </button>
        <button
          type="button"
          disabled={!graph || running}
          onClick={() => useWorkGraphStore.getState().resetRun()}
          title={t('workGraph.resetTitle')}
          className="inline-flex h-7 items-center gap-1 rounded-md bg-surface-2 px-2 text-caption text-fg-secondary hover:text-fg-primary hover:bg-surface-3 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none transition-colors duration-fast active:scale-[0.99]"
        >
          <RotateCcw size={12} />
          {t('workGraph.reset')}
        </button>
        <button
          type="button"
          aria-label={t('workGraph.clearGraph')}
          title={t('workGraph.clearGraph')}
          disabled={!graph || running}
          onClick={() => {
            if (confirmClear) {
              useWorkGraphStore.getState().clearGraph();
              setConfirmClear(false);
            } else {
              setConfirmClear(true);
            }
          }}
          className="ml-auto inline-flex h-7 items-center gap-1 rounded-md px-2 text-caption text-fg-tertiary hover:bg-error-subtle hover:text-error disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none transition-colors duration-fast active:scale-[0.99]"
        >
          <Trash2 size={12} />
        </button>
      </div>
      <p className="mt-1.5 text-caption text-fg-tertiary tabular-nums">{summary}</p>
      {confirmClear ? (
        <p className="mt-1.5 rounded-r border-l-2 border-warning bg-warning-subtle px-2 py-1 text-caption text-warning">
          {t('workGraph.clearConfirm')}
        </p>
      ) : runNote ? (
        <p key={runNote} className="mt-1.5 rounded-r border-l-2 border-warning bg-warning-subtle px-2 py-1 text-caption text-warning motion-safe:animate-fade-rise">{runNote}</p>
      ) : null}
    </div>
  );
}
