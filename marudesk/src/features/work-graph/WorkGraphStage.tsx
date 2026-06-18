import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { Maximize2, Minus, Plus, RotateCcw, Workflow } from 'lucide-react';
import { WorkGraphNodes, WorkGraphPanel, NODE_H, NODE_W } from './WorkGraphLayer';
import { WorkGraphInspector } from './WorkGraphInspector';
import { useWorkGraphStore } from './store';

/**
 * The **AI Work OS** stage (docs/ai-work-os-roadmap.md §3): a goal decomposed
 * into a Task graph on its *own* pannable/zoomable plane — deliberately separate
 * from the canvas-of-cards so Task nodes (meaning) never share a plane with tool
 * cards (tools), the anti-pattern §4 forbids. Tools open in the sibling dock, not
 * inside a node.
 *
 * Owns a self-contained viewport (pan + zoom) rather than reusing the canvas
 * placement store, so panning the Work OS never moves the canvas-of-cards. Node
 * positions are keyed by `Task.id` in {@link useWorkGraphStore}.
 */

const SCALE_MIN = 0.25;
const SCALE_MAX = 2.5;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

type Viewport = { panX: number; panY: number; scale: number };

export function WorkGraphStage() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [vp, setVp] = useState<Viewport>({ panX: 0, panY: 0, scale: 1 });
  const graph = useWorkGraphStore((s) => s.graph);

  // Screen px → graph coords (inverse of the plane's translate+scale).
  const toCanvas = useCallback(
    (clientX: number, clientY: number) => {
      const r = ref.current?.getBoundingClientRect();
      const left = r?.left ?? 0;
      const top = r?.top ?? 0;
      return { x: (clientX - left - vp.panX) / vp.scale, y: (clientY - top - vp.panY) / vp.scale };
    },
    [vp.panX, vp.panY, vp.scale],
  );

  // Zoom by `factor`, keeping the container-relative point (cx,cy) fixed.
  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    setVp((v) => {
      const scale = clamp(v.scale * factor, SCALE_MIN, SCALE_MAX);
      const k = scale / v.scale;
      return { scale, panX: cx - (cx - v.panX) * k, panY: cy - (cy - v.panY) * k };
    });
  }, []);

  const zoomFromCenter = useCallback(
    (factor: number) => {
      const r = ref.current?.getBoundingClientRect();
      zoomAt(factor, (r?.width ?? 0) / 2, (r?.height ?? 0) / 2);
    },
    [zoomAt],
  );

  // Fit every node within the viewport, with padding.
  const fit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const positions = Object.values(useWorkGraphStore.getState().pos);
    if (positions.length === 0) {
      setVp({ panX: 0, panY: 0, scale: 1 });
      return;
    }
    const minX = Math.min(...positions.map((p) => p.x));
    const minY = Math.min(...positions.map((p) => p.y));
    const maxX = Math.max(...positions.map((p) => p.x + NODE_W));
    const maxY = Math.max(...positions.map((p) => p.y + NODE_H));
    const r = el.getBoundingClientRect();
    const pad = 80;
    const w = maxX - minX || 1;
    const h = maxY - minY || 1;
    const scale = clamp(Math.min(1, Math.min((r.width - pad * 2) / w, (r.height - pad * 2) / h)), SCALE_MIN, SCALE_MAX);
    setVp({
      panX: (r.width - w * scale) / 2 - minX * scale,
      panY: (r.height - h * scale) / 2 - minY * scale,
      scale,
    });
  }, []);

  // Stop any in-flight run when this stage unmounts (Shell conditionally renders
  // WorkGraphStage, so the module-level store would keep mutating otherwise).
  useEffect(() => () => {
    if (useWorkGraphStore.getState().running) useWorkGraphStore.getState().stopRun();
  }, []);

  // Auto-fit when a fresh graph appears (generate / first paint). Deferred to the
  // next frame (not a synchronous setState in the effect) and reads the latest
  // graph from the store, so only a new graph identity (graph?.id) re-triggers —
  // a mid-run status change does not re-fit.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      if (useWorkGraphStore.getState().graph) fit();
    });
    return () => cancelAnimationFrame(raf);
  }, [graph?.id, fit]);

  // Non-passive wheel: ⌘/Ctrl+wheel zooms at the cursor, plain wheel pans.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect();
        zoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - r.left, e.clientY - r.top);
      } else {
        setVp((v) => ({ ...v, panX: v.panX - e.deltaX, panY: v.panY - e.deltaY }));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  // Drag the empty background to pan (nodes stopPropagation, so this only fires
  // on the canvas itself).
  const panRef = useRef<{ id: number; sx: number; sy: number; px: number; py: number } | null>(null);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    useWorkGraphStore.getState().selectTask(null);
    e.currentTarget.setPointerCapture(e.pointerId);
    panRef.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, px: vp.panX, py: vp.panY };
    if (ref.current) ref.current.dataset.panning = '';
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = panRef.current;
    if (!p || p.id !== e.pointerId) return;
    setVp((v) => ({ ...v, panX: p.px + (e.clientX - p.sx), panY: p.py + (e.clientY - p.sy) }));
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (panRef.current?.id === e.pointerId) {
      panRef.current = null;
      if (ref.current) delete ref.current.dataset.panning;
    }
  };

  return (
    <div
      ref={ref}
      data-stage="workgraph"
      aria-label="Work OS task graph"
      tabIndex={-1}
      className="relative h-full w-full flex-1 overflow-clip bg-surface-page cursor-grab data-[panning]:cursor-grabbing"
      style={{
        backgroundImage: 'radial-gradient(var(--border-subtle) 1px, transparent 1.6px)',
        backgroundSize: `${24 * vp.scale}px ${24 * vp.scale}px`,
        backgroundPosition: `${vp.panX}px ${vp.panY}px`,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div
        className="absolute inset-0 origin-top-left"
        style={{ transform: `translate(${vp.panX}px, ${vp.panY}px) scale(${vp.scale})` }}
      >
        <WorkGraphNodes toCanvas={toCanvas} scale={vp.scale} />
      </div>

      {/* Goal input + run/add/reset controls (always present on this surface). */}
      <WorkGraphPanel />

      {/* Selected-task supervision panel: intent, acceptance, evidence result. */}
      <WorkGraphInspector />

      {/* Empty state — points at the panel to generate a first graph. */}
      {!graph ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="flex max-w-xs flex-col items-center gap-3 text-center animate-fade-rise">
            <Workflow size={24} className="text-fg-tertiary" />
            <p className="text-body font-medium text-fg-secondary">No task graph yet.</p>
            <p className="text-caption text-fg-tertiary">
              Describe a goal in the panel to decompose it into a Task graph — each node runs an
              agent and reports pass/fail against its acceptance criteria.
            </p>
          </div>
        </div>
      ) : null}

      {/* Viewport controls (bottom-right). */}
      <div className="absolute bottom-4 right-4 z-50 flex items-center gap-0.5 rounded-lg chrome-panel px-1.5 py-1 shadow-card">
        <CtrlButton label="Zoom out" onClick={() => zoomFromCenter(1 / 1.2)}>
          <Minus size={14} />
        </CtrlButton>
        <button
          type="button"
          className="min-w-[3.25rem] px-1 text-center text-caption tabular-nums text-fg-secondary hover:text-fg-primary transition-transform duration-fast active:scale-[0.99]"
          onClick={() => setVp((v) => ({ ...v, scale: 1 }))}
          title="Reset zoom to 100%"
        >
          {Math.round(vp.scale * 100)}%
        </button>
        <CtrlButton label="Zoom in" onClick={() => zoomFromCenter(1.2)}>
          <Plus size={14} />
        </CtrlButton>
        <div className="mx-0.5 h-5 w-px bg-subtle" />
        <CtrlButton label="Fit to content" onClick={fit}>
          <Maximize2 size={14} />
        </CtrlButton>
        <CtrlButton label="Reset view" onClick={() => setVp({ panX: 0, panY: 0, scale: 1 })}>
          <RotateCcw size={14} />
        </CtrlButton>
      </div>
    </div>
  );
}

function CtrlButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid h-7 w-7 place-items-center rounded text-fg-secondary transition-colors duration-fast hover:bg-surface-3 hover:text-fg-primary active:scale-[0.99] focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
    >
      {children}
    </button>
  );
}
