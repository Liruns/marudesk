import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { Maximize2, Minus, Plus, RotateCcw } from 'lucide-react';
import { WorkGraphNodes, WorkGraphPanel, NODE_H, NODE_W } from './WorkGraphLayer';
import { WorkGraphInspector } from './WorkGraphInspector';
import { useWorkGraphStore } from './store';
import { ZoomSlider } from '../../components/ui';
import { useI18n } from '../../i18n/useI18n';
import { cn } from '../../lib/cn';

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

export function WorkGraphStage({ docked = false }: { docked?: boolean }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement | null>(null);
  const [vp, setVp] = useState<Viewport>({ panX: 0, panY: 0, scale: 1 });
  // Latest viewport mirrored into a ref so the per-node callbacks (`toCanvas`,
  // `getScale`) can read the live pan/zoom WITHOUT closing over `vp` — keeping
  // their identity stable across a pan frame. The transform itself still reads
  // `vp` from state, so the STAGE re-renders to move the plane while the
  // memoized TaskNodeCards do not. (`vpRef` is updated synchronously in every
  // setVp call below so a reader never sees a stale frame.)
  const vpRef = useRef<Viewport>(vp);
  const [animCam, setAnimCam] = useState(false);
  const graph = useWorkGraphStore((s) => s.graph);
  // The floating inspector overlay (w-80 at right-4) covers the lower-right — shift
  // the viewport controls left while a task is selected so they're never hidden.
  // In Mission Control (`docked`) the inspector lives in the Instrument Dock (a
  // layout sibling), so the floating overlay and the control shift are suppressed.
  const selectedOpen = useWorkGraphStore((s) => s.selectedTaskId !== null);
  const inspectorOpen = !docked && selectedOpen;

  // Keyboard a11y: when a node's selection clears (Escape on the stage, the
  // inspector/dock close button), return focus to the node — it carries tabIndex=0
  // — so keyboard users keep their place instead of being dropped to document
  // start. Mirrors the Flight Log's focus-restore. Only when focus was left stale
  // (the now-tabIndex=-1 stage, the body, or the collapsing dock), never if the
  // user has since moved focus somewhere deliberate.
  const selectedTaskId = useWorkGraphStore((s) => s.selectedTaskId);
  const prevSelectedRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevSelectedRef.current;
    prevSelectedRef.current = selectedTaskId;
    if (!prev || selectedTaskId !== null) return;
    const node = document.querySelector<HTMLElement>(`[data-task-node="${prev}"]`);
    if (!node) return;
    const active = document.activeElement;
    const stale =
      active === null ||
      active === document.body ||
      (active instanceof HTMLElement &&
        (active.closest('[data-stage="workgraph"]') !== null ||
          active.closest('[aria-label="Task instrument dock"]') !== null));
    if (stale) node.focus();
  }, [selectedTaskId]);

  // Single entry point for viewport changes: mirror into `vpRef` (so the stable
  // callbacks read the live value) and into React state (so the plane re-renders).
  // Accepts either a Viewport or a functional updater, matching setVp's contract.
  const commitVp = useCallback((next: Viewport | ((v: Viewport) => Viewport)) => {
    setVp((v) => {
      const resolved = typeof next === 'function' ? next(v) : next;
      vpRef.current = resolved;
      return resolved;
    });
  }, []);

  const setVpAnimated = useCallback(
    (next: Viewport) => {
      setAnimCam(true);
      commitVp(next);
      requestAnimationFrame(() => setTimeout(() => setAnimCam(false), 220));
    },
    [commitVp],
  );

  // Screen px → graph coords (inverse of the plane's translate+scale). Reads the
  // live viewport from `vpRef` so the callback identity is STABLE across pans —
  // it no longer closes over `vp.panX/panY/scale`, so TaskNodeCard's memo holds.
  const toCanvas = useCallback((clientX: number, clientY: number) => {
    const r = ref.current?.getBoundingClientRect();
    const left = r?.left ?? 0;
    const top = r?.top ?? 0;
    const v = vpRef.current;
    return { x: (clientX - left - v.panX) / v.scale, y: (clientY - top - v.panY) / v.scale };
  }, []);

  // Stable getter for the live zoom — passed to nodes instead of a `scale` prop
  // so node drag math (onHeaderMove) reads the current scale without re-rendering
  // every node on zoom. Identity never changes.
  const getScale = useCallback(() => vpRef.current.scale, []);

  // Zoom by `factor`, keeping the container-relative point (cx,cy) fixed.
  const zoomAt = useCallback(
    (factor: number, cx: number, cy: number) => {
      commitVp((v) => {
        const scale = clamp(v.scale * factor, SCALE_MIN, SCALE_MAX);
        const k = scale / v.scale;
        return { scale, panX: cx - (cx - v.panX) * k, panY: cy - (cy - v.panY) * k };
      });
    },
    [commitVp],
  );

  const zoomFromCenter = useCallback(
    (factor: number) => {
      const r = ref.current?.getBoundingClientRect();
      const cx = (r?.width ?? 0) / 2;
      const cy = (r?.height ?? 0) / 2;
      // Functional update reads the latest viewport (no stale closure, no ref-in-render),
      // with the camera-transition flag for a smooth move.
      setAnimCam(true);
      commitVp((v) => {
        const scale = clamp(v.scale * factor, SCALE_MIN, SCALE_MAX);
        const k = scale / v.scale;
        return { scale, panX: cx - (cx - v.panX) * k, panY: cy - (cy - v.panY) * k };
      });
      requestAnimationFrame(() => setTimeout(() => setAnimCam(false), 220));
    },
    [commitVp],
  );

  // Fit every node within the viewport, with padding.
  const fit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const positions = Object.values(useWorkGraphStore.getState().pos);
    if (positions.length === 0) {
      setVpAnimated({ panX: 0, panY: 0, scale: 1 });
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
    setVpAnimated({
      panX: (r.width - w * scale) / 2 - minX * scale,
      panY: (r.height - h * scale) / 2 - minY * scale,
      scale,
    });
  }, [setVpAnimated]);

  // NOTE: a run is owned by the module-level store (guarded by runToken), not by
  // this component — so opening an instrument (which unmounts the stage) must NOT
  // cancel it. The run keeps progressing and is reflected again when the graph
  // remounts. (Previously an unmount handler called stopRun(), which aborted a
  // run whenever a tool was summoned mid-flight.)

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
        commitVp((v) => ({ ...v, panX: v.panX - e.deltaX, panY: v.panY - e.deltaY }));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt, commitVp]);

  // Drag the empty background to pan (nodes stopPropagation, so this only fires
  // on the canvas itself).
  const panRef = useRef<{ id: number; sx: number; sy: number; px: number; py: number } | null>(null);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    useWorkGraphStore.getState().selectTask(null);
    e.currentTarget.setPointerCapture(e.pointerId);
    panRef.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, px: vpRef.current.panX, py: vpRef.current.panY };
    if (ref.current) ref.current.dataset.panning = '';
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = panRef.current;
    if (!p || p.id !== e.pointerId) return;
    commitVp((v) => ({ ...v, panX: p.px + (e.clientX - p.sx), panY: p.py + (e.clientY - p.sy) }));
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
      aria-label={t('workGraph.stage.ariaLabel')}
      tabIndex={-1}
      className="relative h-full w-full flex-1 min-w-0 overflow-clip bg-surface-page cursor-grab data-[panning]:cursor-grabbing"
      style={{
        backgroundImage: 'radial-gradient(var(--border-subtle) 1px, transparent 1.6px)',
        backgroundSize: `${clamp(20 * vp.scale, 16, 48)}px ${clamp(20 * vp.scale, 16, 48)}px`,
        backgroundPosition: `${vp.panX}px ${vp.panY}px`,
      }}
      onKeyDown={(e) => { if (e.key === 'Escape') useWorkGraphStore.getState().selectTask(null); }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div
        className={cn('absolute inset-0 origin-top-left', animCam && 'motion-safe:transition-transform motion-safe:duration-standard')}
        style={{ transform: `translate(${vp.panX}px, ${vp.panY}px) scale(${vp.scale})` }}
      >
        <WorkGraphNodes toCanvas={toCanvas} getScale={getScale} />
      </div>

      {/* Goal input + run/add/reset controls (always present on this surface). */}
      <WorkGraphPanel />

      {/* Selected-task supervision panel (floating; Mission Control docks it instead). */}
      {docked ? null : <WorkGraphInspector />}

      {/* Viewport controls (bottom-right) — only meaningful once a graph exists to
          pan/zoom; on the empty home they would just be dead chrome over the hero. */}
      {graph ? (
      <div
        className={cn(
          'absolute bottom-4 z-50 flex items-center gap-0.5 rounded-lg chrome-panel px-1.5 py-1 shadow-card transition-[right] duration-standard',
          inspectorOpen ? 'right-[344px]' : 'right-4',
        )}
      >
        <CtrlButton label={t('canvas.control.zoomOut')} onClick={() => zoomFromCenter(1 / 1.2)}>
          <Minus size={14} />
        </CtrlButton>
        {/* Zoom slider — drags the scale directly; zooms about the viewport center
            so the graph doesn't jump. The 100%-reset button kept to the right of
            the slider gives a one-click escape hatch. */}
        <ZoomSlider
          value={vp.scale}
          min={SCALE_MIN}
          max={SCALE_MAX}
          step={0.05}
          onChange={(next) => {
            const r = ref.current?.getBoundingClientRect();
            const cx = (r?.width ?? 0) / 2;
            const cy = (r?.height ?? 0) / 2;
            commitVp((v) => {
              const k = next / v.scale;
              return { scale: next, panX: cx - (cx - v.panX) * k, panY: cy - (cy - v.panY) * k };
            });
          }}
          className="mx-1"
        />
        <button
          type="button"
          className="h-7 min-w-[3.25rem] px-1 text-center text-caption tabular-nums text-fg-secondary hover:text-fg-primary transition-colors duration-fast active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
          onClick={() => setVpAnimated({ ...vpRef.current, scale: 1 })}
          title={t('canvas.control.resetZoom')}
        >
          {Math.round(vp.scale * 100)}%
        </button>
        <CtrlButton label={t('canvas.control.zoomIn')} onClick={() => zoomFromCenter(1.2)}>
          <Plus size={14} />
        </CtrlButton>
        <div className="mx-1 w-px self-stretch border-l border-default" />
        <CtrlButton label={t('canvas.control.fit')} onClick={fit}>
          <Maximize2 size={14} />
        </CtrlButton>
        <CtrlButton label={t('canvas.control.resetView')} onClick={() => setVpAnimated({ panX: 0, panY: 0, scale: 1 })}>
          <RotateCcw size={14} />
        </CtrlButton>
      </div>
      ) : null}
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
