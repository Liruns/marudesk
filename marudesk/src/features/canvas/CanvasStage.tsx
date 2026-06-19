import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  Check,
  ChevronDown,
  CopyPlus,
  Globe,
  Group,
  Layers,
  LayoutGrid,
  ListTree,
  Map as MapIcon,
  Maximize2,
  Minus,
  Pencil,
  Plus,
  RotateCcw,
  StickyNote,
  Trash2,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { useI18n } from '../../i18n/useI18n';
import { ContextMenu, type MenuItem } from '../../components/ContextMenu';
import type { TabKind, TabState } from '../../../shared/browser';
import { useTabsStore } from '../tabs/store';
import { tabKinds } from '../tabs/registry';
import { useWorkspaceDeckStore } from '../workspaces/store';
import { NameDialog } from '../workspaces/NameDialog';
import { CanvasCard, type CardGroupProps } from './CanvasCard';
import { CanvasSections } from './CanvasSections';
import { CanvasEdges, type ConnectPreview } from './CanvasEdges';
import { CanvasMinimap } from './CanvasMinimap';
import { CanvasNotes } from './CanvasNotes';
import { CanvasPlanFlow } from './CanvasPlanFlow';
import { CanvasShortcuts } from './CanvasShortcuts';
import { easeOutBack, fitPose } from './camera-math';
import { edgeEndpoints, edgeMidpoint, nearestSide } from './edgeGeometry';
import { cardDefaultSize, placementKey, SCALE_MAX, SCALE_MIN, useCanvasStore, type CardGroup, type CardRect, type EdgeSide } from './store';
import { FILE_DND_MIME, openFileDragAsTab, parseFileDrag } from '../workspace/fileDrag';

type CanvasMenu =
  | { x: number; y: number; kind: 'canvas' }
  | { x: number; y: number; kind: 'card'; tabId: string }
  | { x: number; y: number; kind: 'edge'; edgeId: string };

/**
 * Recreate a tab's content as a fresh `browser:tabs-new` payload (for Duplicate
 * canvas) — mirrors the canvas store's `descriptorOf`, but produces the spec the
 * tab factory consumes. A duplicated devtools card keeps inspecting the original
 * web tab (still open).
 */
function tabToNewTabPayload(
  tab: TabState,
  workspaceId: string | undefined,
): Parameters<typeof window.marudesk.invoke<'browser:tabs-new'>>[1] {
  const ws = workspaceId ? { workspaceId } : {};
  switch (tab.kind) {
    case 'web':
      return { kind: 'web', ...(tab.url ? { url: tab.url } : {}), ...ws };
    case 'editor':
      return { kind: 'editor', ...(tab.filePath ? { path: tab.filePath } : {}), ...ws };
    case 'terminal':
      return { kind: 'terminal', ...(tab.terminalProfile ? { terminalProfile: tab.terminalProfile } : {}), ...ws };
    case 'plugin':
      return { kind: 'plugin', ...(tab.pluginPanel ? { pluginPanel: tab.pluginPanel } : {}), ...ws };
    case 'devtools':
      return { kind: 'devtools', ...(tab.devtoolsTargetTabId ? { devtoolsTargetTabId: tab.devtoolsTargetTabId } : {}), ...ws };
    default:
      return { kind: tab.kind, ...ws };
  }
}

/**
 * Run `cb` once a tab has a canvas placement (its card has materialized).
 * Tabs created via `browser:tabs-new` only enter the store on the next-tick
 * `browser:tabs-state` push, so focus/raise has to wait for the card to exist.
 * Fires immediately if it's already placed; gives up after `timeoutMs` so a tab
 * that never lands (creation failed) can't leak the subscription.
 */
function whenPlaced(tabId: string, cb: () => void, timeoutMs = 4000): void {
  if (useCanvasStore.getState().placements[tabId]) {
    cb();
    return;
  }
  let done = false;
  const finish = (run: boolean) => {
    if (done) return;
    done = true;
    unsub();
    clearTimeout(timer);
    if (run) cb();
  };
  const unsub = useCanvasStore.subscribe((s) => {
    if (s.placements[tabId]) finish(true);
  });
  const timer = setTimeout(() => finish(false), timeoutMs);
}

/** Resolve once every id has a placement (or `timeoutMs` elapses — best effort). */
function waitForPlacements(ids: readonly string[], timeoutMs = 5000): Promise<void> {
  const have = () => ids.every((id) => !!useCanvasStore.getState().placements[id]);
  if (ids.length === 0 || have()) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      unsub();
      clearTimeout(timer);
      resolve();
    };
    const unsub = useCanvasStore.subscribe(() => {
      if (have()) finish();
    });
    const timer = setTimeout(finish, timeoutMs);
  });
}

/**
 * The id set of tabs visible on the canvas right now — the active workspace's
 * tabs, or all tabs when none is active — read fresh from the stores so a mid-
 * interaction workspace switch is reflected immediately.
 */
function visibleTabIds(): Set<string> {
  const aws = useWorkspaceDeckStore.getState().activeWorkspaceId;
  const tabs = useTabsStore.getState().tabs;
  return new Set((aws ? tabs.filter((t) => t.workspaceId === aws) : tabs).map((t) => t.id));
}

/**
 * A predicate over placement keys: is this card/group currently rendered? A group
 * renders if any member is visible; an ungrouped tab if it's visible and not
 * absorbed into a group. The caller supplies `vis` so a drag-time caller can pass
 * the render-time set while a fresh caller passes a live {@link visibleTabIds}.
 */
function renderedPredicate(vis: Set<string>, groups: readonly CardGroup[]): (key: string) => boolean {
  const grouped = new Set(groups.flatMap((g) => g.tabIds));
  return (key) => {
    const grp = groups.find((g) => g.id === key);
    return grp ? grp.tabIds.some((id) => vis.has(id)) : vis.has(key) && !grouped.has(key);
  };
}

/**
 * A live alignment guide shown while a card snaps to another mid-drag: an axis
 * line at canvas coordinate `at`, spanning `from`→`to` along the other axis so it
 * visually bridges the dragged card and the card it lined up with.
 */
type SnapGuide = { axis: 'x' | 'y'; at: number; from: number; to: number };

/**
 * Focus + raise a card once it has a placement (its card has materialized) — run
 * after creating/opening a card so the new surface becomes the live one
 * immediately (matters for agent cards, which only run live when focused).
 */
function raiseWhenPlaced(tabId: string): void {
  whenPlaced(tabId, () => {
    const s = useCanvasStore.getState();
    s.setFocused(tabId);
    s.bringToFront(tabId);
  });
}

/**
 * The infinite-canvas surface (Maru — see docs/maru-identity-and-canvas-design.md).
 * A pannable / zoomable plane that hosts every open tab as a freeform card. Pan by
 * dragging empty space or scrolling; zoom with ⌘/Ctrl + wheel or the controls.
 *
 * Feature cards render via the shared `tabKinds` registry; web cards report their
 * (post-transform) screen rect through the same `set-pane-bounds` pipeline the
 * split grid uses (electron/browser/layout.ts), so the live WebContentsView tracks
 * the card. Repositioning is coalesced to one IPC per animation frame.
 */
/** True when the OS asks for reduced motion (gesture inertia should be skipped). */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function CanvasStage() {
  const { t, formatCanvasGroupSection } = useI18n();
  const tabs = useTabsStore((s) => s.tabs);
  const activateTab = useTabsStore((s) => s.activateTab);
  const placements = useCanvasStore((s) => s.placements);
  const edges = useCanvasStore((s) => s.edges);
  const edgeStyle = useCanvasStore((s) => s.edgeStyle);
  const groups = useCanvasStore((s) => s.groups);
  const sections = useCanvasStore((s) => s.sections);
  const notes = useCanvasStore((s) => s.notes);
  const selection = useCanvasStore((s) => s.selection);
  const selectedEdgeId = useCanvasStore((s) => s.selectedEdgeId);
  const viewport = useCanvasStore((s) => s.viewport);
  const focusedTabId = useCanvasStore((s) => s.focusedTabId);
  const activeWorkspaceId = useWorkspaceDeckStore((s) => s.activeWorkspaceId);
  const workspaces = useWorkspaceDeckStore((s) => s.workspaces);
  // The open workspace's canvases (a canvas = a named saved layout). The bucket
  // only changes on a canvas op (switch/new/rename/delete), not on every
  // drag/pan, so this selector is cheap.
  const canvasBucket = useCanvasStore((s) => s.byWorkspace[s.wsKey]);
  const activeCanvasId = useCanvasStore((s) => s.activeCanvasId);
  const canvasList = canvasBucket
    ? canvasBucket.order.map((id) => canvasBucket.canvases[id]).filter((d): d is NonNullable<typeof d> => !!d)
    : [];
  const activeCanvasName = canvasBucket?.canvases[activeCanvasId]?.name ?? t('canvas.toolbar.canvasFallback');

  // Scope cards to the active workspace so multiple workspaces don't pile onto
  // one canvas; fall back to all tabs when no workspace is active. Placements are
  // keyed by (unique) tab id (or a group id), so the shared store needs no
  // per-workspace split.
  const visibleTabs = activeWorkspaceId
    ? tabs.filter((t) => t.workspaceId === activeWorkspaceId)
    : tabs;
  const visibleIds = new Set(visibleTabs.map((t) => t.id));
  const sectionIds = new Set(sections.map((s) => s.id));
  // Map a tab to its placement key (group id when merged) for edge anchoring; a
  // section id is its own key.
  const keyOf = (tabId: string): string => placementKey(groups, tabId);
  // An edge endpoint is visible if it's a visible tab or a section on this canvas.
  const nodeVisible = (key: string): boolean => visibleIds.has(key) || sectionIds.has(key);
  // Edge endpoints resolve their rect from cards (placements) OR sections, so a
  // card↔section / section↔section wire anchors to the section frame.
  const nodeRects: Record<string, CardRect> = { ...placements };
  for (const s of sections) nodeRects[s.id] = { x: s.x, y: s.y, w: s.w, h: s.h, z: 0 };
  // Only draw edges whose both endpoints are visible; skip intra-group edges
  // (both ends resolve to the same card).
  const visibleEdges = edges.filter(
    (e) => nodeVisible(e.from) && nodeVisible(e.to) && keyOf(e.from) !== keyOf(e.to),
  );
  const activeWsName = workspaces.find((w) => w.id === activeWorkspaceId)?.name;

  // Live connection-drag preview (canvas coords of the loose end), or null.
  const [connect, setConnect] = useState<ConnectPreview | null>(null);
  // Container size (px) for the minimap's viewport overlay, and minimap toggle.
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [minimapOpen, setMinimapOpen] = useState(true);
  // The AI process-flow overlay (the focused chat's plan as a node graph).
  const [planFlowOpen, setPlanFlowOpen] = useState(true);
  // Placement key of the card highlighted as a merge drop-target mid-drag, or null.
  const [mergeTarget, setMergeTarget] = useState<string | null>(null);
  // Right-click context menu (canvas / card / edge), or null.
  const [menu, setMenu] = useState<CanvasMenu | null>(null);
  // Workspace-switcher dropdown anchor (canvas mode has no workspace rail).
  const [wsMenu, setWsMenu] = useState<{ x: number; y: number } | null>(null);
  // Canvas-switcher dropdown anchor + the name dialog (new / rename a canvas).
  const [canvasMenu, setCanvasMenu] = useState<{ x: number; y: number } | null>(null);
  const [nameDialog, setNameDialog] = useState<
    { mode: 'new' } | { mode: 'rename'; id: string; initial: string } | null
  >(null);
  // Marquee (drag-box) selection rect in canvas coords while dragging, or null.
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  // Keyboard cheat-sheet overlay (opened with `?`).
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // Live alignment guides shown while a card snaps mid-drag (Figma/tldraw style).
  const [dragGuides, setDragGuides] = useState<SnapGuide[]>([]);
  const dragGuidesSigRef = useRef('');
  // True while Space is held → empty-canvas left-drag pans instead of marqueeing.
  const [spacePan, setSpacePan] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  // The CSS-transformed plane (cards live inside it). Panning writes its transform
  // directly so a drag never re-renders React — the perf fix for "휠 클릭 버벅거림".
  const planeRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  // Smoothed pan velocity (screen px/ms) for fling inertia, and the inertia rAF.
  const panVelRef = useRef<{ vx: number; vy: number; t: number } | null>(null);
  const inertiaRef = useRef<number | null>(null);
  // Live (uncommitted) viewport while a pan OR zoom gesture is in flight, or null
  // when the store is authoritative. The plane/grid transform is driven straight
  // from this on each pointer/wheel/animation frame, and only committed to the
  // store on gesture end — so cards/edges aren't re-rendered ~120×/sec mid-gesture.
  // Zoom carries `scale` too (pan leaves it at the committed value).
  const liveRef = useRef<{ panX: number; panY: number; scale: number } | null>(null);
  // Trailing-commit timer for wheel panning (no pointerup to commit on).
  const wheelCommitRef = useRef<number | null>(null);
  // Active eased-zoom glide: the target scale + the container-px anchor the cursor
  // is pinned to, and the rAF handle driving the ease. Null when no zoom is gliding.
  const zoomRef = useRef<{ target: number; anchorX: number; anchorY: number; raf: number | null } | null>(null);
  // Marquee anchor (canvas coords) + the multi-selection store keys it began with.
  const marqueeRef = useRef<{ pointerId: number; ox: number; oy: number } | null>(null);
  const spaceDownRef = useRef(false);
  const [panning, setPanning] = useState(false);
  // Live element refs for web cards, keyed by tab id, so we can measure their
  // screen rects and position the matching native WebContentsViews.
  const webEls = useRef<Map<string, HTMLDivElement>>(new Map());
  // Coalesce web-view repositioning to one IPC per animation frame and skip it
  // when nothing moved — pan/zoom otherwise fires set-pane-bounds on every
  // pointer event (100+/sec).
  const rafRef = useRef<number | null>(null);
  const lastSentRef = useRef<string>('');

  const tabIdsKey = tabs.map((t) => t.id).join('\n');

  const registerWebEl = useCallback((tabId: string, el: HTMLDivElement | null) => {
    if (el) webEls.current.set(tabId, el);
    else webEls.current.delete(tabId);
  }, []);

  // Position live web views to follow their cards through the SAME pane-bounds
  // pipeline the split grid uses (electron/browser/layout.ts). An empty list
  // still means "grid mode" → every web view hides, so feature-only canvases
  // show the React surfaces through. `getBoundingClientRect()` is post-transform,
  // so the reported rect already reflects pan + zoom.
  const measureWeb = useCallback(() => {
    if (rafRef.current !== null) return; // already scheduled this frame
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const panes: { tabId: string; rect: { x: number; y: number; width: number; height: number } }[] = [];
      for (const [tabId, el] of webEls.current) {
        const r = el.getBoundingClientRect();
        // Skip a not-yet-laid-out element (0×0): sending it would size the native
        // view to nothing (blank). The ResizeObserver re-measures once it has a
        // real size, so the view appears as soon as layout settles.
        if (r.width < 1 || r.height < 1) continue;
        panes.push({
          tabId,
          rect: {
            x: Math.round(r.left),
            y: Math.round(r.top),
            width: Math.round(r.width),
            height: Math.round(r.height),
          },
        });
      }
      // Send the canvas zoom so main scales each web view's page to match. During a
      // live pan/zoom the store scale is stale, so prefer the in-flight live scale
      // — otherwise web cards wouldn't track the zoom until the gesture committed.
      const scale = liveRef.current?.scale ?? useCanvasStore.getState().viewport.scale;
      const key = JSON.stringify({ panes, scale });
      if (key === lastSentRef.current) return; // nothing changed → skip the IPC
      lastSentRef.current = key;
      void window.marudesk.invoke('browser:set-pane-bounds', { panes, scale });
    });
  }, []);

  // Seed the live viewport from the store on the first event of a gesture, and
  // promote the plane to its own compositor layer for the duration so pan/zoom run
  // as GPU transforms (no paint). `will-change` is dropped again on commit so the
  // plane re-rasterizes at rest — that's what keeps card text crisp when idle.
  const seedLive = useCallback(() => {
    if (!liveRef.current) {
      const vp = useCanvasStore.getState().viewport;
      liveRef.current = { panX: vp.panX, panY: vp.panY, scale: vp.scale };
    }
    if (planeRef.current) planeRef.current.style.willChange = 'transform';
    return liveRef.current;
  }, []);

  // Write the live viewport straight to the DOM (plane transform + grid background)
  // so a pan/zoom moves at the compositor's pace without a React re-render. The
  // store stays untouched until the gesture commits.
  const applyLiveTransform = useCallback(() => {
    const lv = liveRef.current;
    if (!lv) return;
    if (planeRef.current) {
      planeRef.current.style.transform = `translate(${lv.panX}px, ${lv.panY}px) scale(${lv.scale})`;
    }
    if (containerRef.current) {
      containerRef.current.style.backgroundPosition = `${lv.panX}px ${lv.panY}px`;
      containerRef.current.style.backgroundSize = `${24 * lv.scale}px ${24 * lv.scale}px`;
    }
  }, []);

  // Accumulate a pan delta onto the live viewport (seeding on the first move),
  // repaint the plane directly, and let the native web views follow (measureWeb is
  // itself rAF-coalesced). A pan cancels any in-flight zoom glide so the two don't
  // fight over the same live viewport.
  const livePanBy = useCallback(
    (dx: number, dy: number) => {
      if (zoomRef.current?.raf != null) cancelAnimationFrame(zoomRef.current.raf);
      zoomRef.current = null;
      const lv = seedLive();
      lv.panX += dx;
      lv.panY += dy;
      applyLiveTransform();
      measureWeb();
    },
    [seedLive, applyLiveTransform, measureWeb],
  );

  // Fold the live viewport back into the store (one update → one re-render), drop
  // the live offset so React owns the transform again, end any zoom glide, and let
  // the plane re-rasterize at rest (will-change off → crisp text).
  const commitLive = useCallback(() => {
    if (inertiaRef.current != null) {
      cancelAnimationFrame(inertiaRef.current);
      inertiaRef.current = null;
    }
    if (zoomRef.current?.raf != null) cancelAnimationFrame(zoomRef.current.raf);
    zoomRef.current = null;
    if (wheelCommitRef.current !== null) {
      clearTimeout(wheelCommitRef.current);
      wheelCommitRef.current = null;
    }
    if (planeRef.current) planeRef.current.style.willChange = '';
    const lv = liveRef.current;
    if (!lv) return;
    liveRef.current = null;
    useCanvasStore.getState().setViewport(lv.panX, lv.panY, lv.scale);
  }, []);

  // Fling inertia: after a fast pan release, glide the live viewport with
  // exponential friction (τ≈220ms) painted straight to the DOM, then commit.
  // The caller gates on reduced-motion / speed; commitLive (or any new gesture)
  // cancels the rAF.
  const startPanInertia = useCallback(
    (vx0: number, vy0: number) => {
      seedLive();
      let vx = vx0;
      let vy = vy0;
      let last = performance.now();
      const step = (now: number) => {
        const dt = Math.min(48, now - last);
        last = now;
        livePanBy(vx * dt, vy * dt);
        const decay = Math.exp(-dt / 220);
        vx *= decay;
        vy *= decay;
        if (Math.hypot(vx, vy) < 0.02) {
          inertiaRef.current = null;
          commitLive();
          return;
        }
        inertiaRef.current = requestAnimationFrame(step);
      };
      inertiaRef.current = requestAnimationFrame(step);
    },
    [seedLive, livePanBy, commitLive],
  );

  // Eased zoom: each wheel notch (or zoom button) nudges a target scale; a rAF loop
  // glides the live scale toward it, anchored at the cursor, painting straight to
  // the DOM. So a zoom never re-renders the card tree mid-gesture (the jank that
  // made wheel-zoom feel choppy) and discrete notches read as one smooth shrink/
  // grow. The glide commits to the store once it settles.
  const smoothZoomBy = useCallback(
    (factor: number, cx: number, cy: number) => {
      // One ease frame: glide the live scale a fraction toward the target, anchored
      // at the cursor, paint straight to the DOM, then re-arm or commit on settle.
      const step = () => {
        const cur = liveRef.current;
        const z = zoomRef.current;
        if (!cur || !z) return;
        // Canvas-space point under the anchor BEFORE the scale step — keep it fixed
        // so the cursor stays pinned to the same content as the scale eases.
        const px = (z.anchorX - cur.panX) / cur.scale;
        const py = (z.anchorY - cur.panY) / cur.scale;
        const done = Math.abs(z.target - cur.scale) < 0.0015;
        cur.scale = done ? z.target : cur.scale + (z.target - cur.scale) * 0.25;
        cur.panX = z.anchorX - px * cur.scale;
        cur.panY = z.anchorY - py * cur.scale;
        applyLiveTransform();
        measureWeb();
        if (done) {
          zoomRef.current = null;
          commitLive();
        } else {
          z.raf = requestAnimationFrame(step);
        }
      };
      const lv = seedLive();
      const base = zoomRef.current?.target ?? lv.scale;
      const target = Math.min(SCALE_MAX, Math.max(SCALE_MIN, base * factor));
      // The glide is the sole committer for a zoom, so cancel any trailing wheel-pan
      // commit that might otherwise fire mid-glide and finalize early.
      if (wheelCommitRef.current !== null) {
        clearTimeout(wheelCommitRef.current);
        wheelCommitRef.current = null;
      }
      // Reduced motion: snap to the target in one step (no rAF glide), keeping the
      // cursor pinned to the same content. Matches the canvas's other gestures
      // (pan/card fling, camera tween, tidy) which all skip motion under
      // prefers-reduced-motion; the zoom glide was the lone holdout.
      if (prefersReducedMotion()) {
        if (zoomRef.current?.raf != null) cancelAnimationFrame(zoomRef.current.raf);
        zoomRef.current = null;
        const cur = liveRef.current ?? lv;
        const px = (cx - cur.panX) / cur.scale;
        const py = (cy - cur.panY) / cur.scale;
        cur.scale = target;
        cur.panX = cx - px * cur.scale;
        cur.panY = cy - py * cur.scale;
        applyLiveTransform();
        measureWeb();
        commitLive();
        return;
      }
      if (zoomRef.current) {
        // A glide is already running — just retarget it (and re-anchor to the new
        // cursor); the live rAF chain picks up the new target/anchor next frame.
        zoomRef.current.target = target;
        zoomRef.current.anchorX = cx;
        zoomRef.current.anchorY = cy;
        if (zoomRef.current.raf === null) zoomRef.current.raf = requestAnimationFrame(step);
        return;
      }
      zoomRef.current = { target, anchorX: cx, anchorY: cy, raf: requestAnimationFrame(step) };
    },
    [seedLive, applyLiveTransform, measureWeb, commitLive],
  );

  // Wheel panning has no pointerup, so commit on a short trailing idle.
  const scheduleWheelCommit = useCallback(() => {
    if (wheelCommitRef.current !== null) clearTimeout(wheelCommitRef.current);
    wheelCommitRef.current = window.setTimeout(() => {
      wheelCommitRef.current = null;
      commitLive();
    }, 140);
  }, [commitLive]);

  // The store is intentionally stale during a pan, so if React happens to
  // re-render mid-gesture (a tab title update, a card animation, …) it paints the
  // plane at the committed offset. Re-assert the live transform after every render
  // (pre-paint) so the pan never snaps back for a frame.
  useLayoutEffect(() => {
    if (liveRef.current) applyLiveTransform();
  });

  // Keep placements in step with the open tabs (initial mount + later changes).
  useEffect(() => {
    useCanvasStore.getState().syncPlacements(tabIdsKey ? tabIdsKey.split('\n') : []);
    // Opening a web card runs createAndActivateTab → showTab in main, which drops
    // the process out of grid mode (single-active path) until the renderer re-asserts
    // pane bounds. Clear the dedup so the NEXT measure always re-sends, re-entering
    // grid mode — otherwise an unchanged pane list is skipped and the card's native
    // view stays at the stale single-view rect, i.e. blank on the canvas.
    lastSentRef.current = '';
  }, [tabIdsKey]);

  // Re-measure web views on any viewport (pan/zoom) or placement (move) change,
  // and on the tab set changing, so the native views track the cards.
  useLayoutEffect(() => {
    measureWeb();
  }, [measureWeb, viewport, placements, tabIdsKey]);

  // Observe each web card's measured element so its native view gets real bounds
  // the moment layout settles — the ref callback can fire before the browser has
  // laid the element out (getBoundingClientRect → 0×0), which left the web view
  // sized 0×0 and blank. A ResizeObserver fires post-layout with the true size
  // (and again on card resize), so the WebContentsView always tracks the card.
  useEffect(() => {
    const ro = new ResizeObserver(() => measureWeb());
    for (const el of webEls.current.values()) ro.observe(el);
    return () => ro.disconnect();
  }, [measureWeb, tabIdsKey]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      measureWeb();
      const r = el.getBoundingClientRect();
      setSize({ w: r.width, h: r.height });
      // Mirror into the store so revealTab/fit can frame a card without the
      // component passing its size down.
      useCanvasStore.getState().setViewportSize(r.width, r.height);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener('resize', update);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [measureWeb]);

  // Leave grid mode on unmount so the classic shell's single active web view is
  // restored when switching back from the canvas (and cancel any pending frame).
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      if (zoomRef.current?.raf != null) cancelAnimationFrame(zoomRef.current.raf);
      if (inertiaRef.current != null) cancelAnimationFrame(inertiaRef.current);
      if (wheelCommitRef.current !== null) clearTimeout(wheelCommitRef.current);
      void window.marudesk.invoke('browser:clear-pane-bounds');
    };
  }, []);

  // Native, non-passive wheel so we can preventDefault: ⌘/Ctrl = zoom-at-cursor,
  // otherwise two-axis pan. React's synthetic onWheel is passive and can't block
  // the browser's own scroll/zoom.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // A wheel gesture takes over the live viewport from any fling (keep the
      // live offset so the wheel continues from where the fling was, no commit).
      if (inertiaRef.current != null) {
        cancelAnimationFrame(inertiaRef.current);
        inertiaRef.current = null;
      }
      if (e.ctrlKey || e.metaKey) {
        // Zoom at the cursor (also catches trackpad pinch, which arrives as
        // ctrl+wheel). Eased + painted straight to the DOM, so consecutive notches
        // glide into one smooth zoom instead of re-rendering the card tree per tick.
        const r = el.getBoundingClientRect();
        smoothZoomBy(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
      } else if (e.shiftKey) {
        // Shift + wheel = horizontal pan (Figma).
        livePanBy(-(e.deltaY || e.deltaX), 0);
        scheduleWheelCommit();
      } else {
        // Plain wheel / trackpad = two-axis pan.
        livePanBy(-e.deltaX, -e.deltaY);
        scheduleWheelCommit();
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [livePanBy, smoothZoomBy, scheduleWheelCommit]);

  // Ctrl/Cmd+wheel over a web card is eaten by its native view, so main forwards
  // it here (see electron/browser/tabs.ts). Zoom the canvas centered on that
  // card, mirroring the container wheel handler's zoom factor.
  useEffect(() => {
    return window.marudesk.on('canvas:wheel', ({ tabId, deltaY }) => {
      const container = containerRef.current;
      if (!container) return;
      const cr = container.getBoundingClientRect();
      let cx = cr.width / 2;
      let cy = cr.height / 2;
      const el = webEls.current.get(tabId);
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          cx = r.left + r.width / 2 - cr.left;
          cy = r.top + r.height / 2 - cr.top;
        }
      }
      smoothZoomBy(Math.exp(-deltaY * 0.0015), cx, cy);
    });
  }, [smoothZoomBy]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // Any pointerdown ends an in-flight fling and folds the live offset into the
    // store, so the interaction starts from a clean, committed viewport.
    commitLive();
    // Never start on a card or an on-canvas control — capturing here would
    // swallow their clicks.
    if ((e.target as HTMLElement).closest('[data-canvas-card], [data-canvas-section], button, [data-edge-id]')) return;
    // Pan with the middle button or Space+left (Figma); plain left marquee-selects
    // empty canvas; right opens the context menu.
    const pan = e.button === 1 || (e.button === 0 && spaceDownRef.current);
    if (pan) {
      e.currentTarget.setPointerCapture(e.pointerId);
      panRef.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
      panVelRef.current = { vx: 0, vy: 0, t: e.timeStamp };
      setPanning(true);
      return;
    }
    if (e.button !== 0) return;
    const store = useCanvasStore.getState();
    store.setFocused(null);
    store.selectEdge(null);
    store.clearSelection();
    e.currentTarget.setPointerCapture(e.pointerId);
    const pt = toCanvas(e.clientX, e.clientY);
    marqueeRef.current = { pointerId: e.pointerId, ox: pt.x, oy: pt.y };
    setMarquee({ x: pt.x, y: pt.y, w: 0, h: 0 });
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = panRef.current;
    if (p && p.pointerId === e.pointerId) {
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      // Track a smoothed velocity (px/ms) for the release fling.
      const now = e.timeStamp;
      const pv = panVelRef.current;
      if (pv) {
        const dt = Math.max(1, now - pv.t);
        pv.vx = pv.vx * 0.6 + (dx / dt) * 0.4;
        pv.vy = pv.vy * 0.6 + (dy / dt) * 0.4;
        pv.t = now;
      }
      // Direct-to-DOM pan — no store write (and no re-render) until pointerup.
      livePanBy(dx, dy);
      return;
    }
    const m = marqueeRef.current;
    if (m && m.pointerId === e.pointerId) {
      const pt = toCanvas(e.clientX, e.clientY);
      setMarquee({
        x: Math.min(m.ox, pt.x),
        y: Math.min(m.oy, pt.y),
        w: Math.abs(pt.x - m.ox),
        h: Math.abs(pt.y - m.oy),
      });
    }
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (panRef.current?.pointerId === e.pointerId) {
      panRef.current = null;
      setPanning(false);
      // A fast release flings the canvas — glide it out with friction; otherwise
      // commit the accumulated offset immediately.
      const pv = panVelRef.current;
      panVelRef.current = null;
      const stale = !pv || e.timeStamp - pv.t > 80;
      const speed = pv ? Math.hypot(pv.vx, pv.vy) : 0;
      if (pv && !stale && speed > 0.08 && !prefersReducedMotion()) {
        startPanInertia(pv.vx, pv.vy);
      } else {
        commitLive();
      }
      return;
    }
    const m = marqueeRef.current;
    if (m && m.pointerId === e.pointerId) {
      marqueeRef.current = null;
      const pt = toCanvas(e.clientX, e.clientY);
      const minX = Math.min(m.ox, pt.x);
      const minY = Math.min(m.oy, pt.y);
      const maxX = Math.max(m.ox, pt.x);
      const maxY = Math.max(m.oy, pt.y);
      setMarquee(null);
      // Threshold in SCREEN px (÷ scale) so the click/drag dead-zone feels the
      // same at every zoom, matching the card header's 3px dead-zone.
      const thresh = 4 / useCanvasStore.getState().viewport.scale;
      if (maxX - minX < thresh && maxY - minY < thresh) return; // a click, not a drag
      const store = useCanvasStore.getState();
      const isRendered = renderedPredicate(visibleIds, groups);
      const sel: string[] = [];
      for (const [key, r] of Object.entries(store.placements)) {
        if (!isRendered(key)) continue;
        if (r.x < maxX && r.x + r.w > minX && r.y < maxY && r.y + r.h > minY) sel.push(key);
      }
      store.setSelection(sel);
    }
  };

  // `placeKey` is the placement key to raise (a group id when the card is a
  // merged group); `tabId` is the surface that gets focus + activation.
  const focusCard = (tabId: string, placeKey: string = tabId) => {
    const store = useCanvasStore.getState();
    store.setFocused(tabId);
    store.bringToFront(placeKey);
    void activateTab(tabId);
  };

  // Snap a moving card's edges (left/right/center + adjacency) to nearby cards
  // within a small threshold — Figma-style alignment; free placement elsewhere.
  // Snapped position for a single dragged card (aligns to other rendered cards),
  // computed WITHOUT writing — the live drag paints the result straight to the DOM.
  const computeSnap = (
    tabId: string,
    x: number,
    y: number,
    exclude?: ReadonlySet<string>,
  ): { x: number; y: number; guides: SnapGuide[] } => {
    const store = useCanvasStore.getState();
    const pl = store.placements;
    const cur = pl[tabId];
    if (!cur) return { x, y, guides: [] };
    const { w, h } = cur;
    // Constant in screen px (so the feel is the same at any zoom).
    const SNAP = 6 / store.viewport.scale;
    // Read the visible set fresh (a mid-drag workspace switch shouldn't snap to
    // the previous workspace's cards).
    const isRendered = renderedPredicate(visibleTabIds(), store.groups);
    let sx = x;
    let sy = y;
    let dx = SNAP;
    let dy = SNAP;
    // Track the winning match per axis so a guide line can be drawn at the shared
    // edge/center and span both cards. `at` is the line coordinate (which may
    // differ from the snapped origin, e.g. a right-edge alignment).
    let gx: { at: number; r: CardRect } | null = null;
    let gy: { at: number; r: CardRect } | null = null;
    // Snap against every rendered card — ungrouped tabs AND merged group cards
    // (keyed by group id), so a card can align to a group, not just plain cards.
    // [snapTo, lineAt] pairs: where the origin lands vs. where the guide is drawn.
    for (const [k, r] of Object.entries(pl)) {
      if (k === tabId || exclude?.has(k)) continue;
      if (!isRendered(k)) continue;
      const xc: readonly [number, number][] = [
        [r.x, r.x], // left ↔ left
        [r.x + r.w - w, r.x + r.w], // right ↔ right
        [r.x + (r.w - w) / 2, r.x + r.w / 2], // center ↔ center
        [r.x + r.w, r.x + r.w], // dragged left edge ↔ r right edge
        [r.x - w, r.x], // dragged right edge ↔ r left edge
      ];
      for (const [snapTo, lineAt] of xc) {
        const d = Math.abs(x - snapTo);
        if (d < dx) {
          dx = d;
          sx = snapTo;
          gx = { at: lineAt, r };
        }
      }
      const yc: readonly [number, number][] = [
        [r.y, r.y],
        [r.y + r.h - h, r.y + r.h],
        [r.y + (r.h - h) / 2, r.y + r.h / 2],
        [r.y + r.h, r.y + r.h],
        [r.y - h, r.y],
      ];
      for (const [snapTo, lineAt] of yc) {
        const d = Math.abs(y - snapTo);
        if (d < dy) {
          dy = d;
          sy = snapTo;
          gy = { at: lineAt, r };
        }
      }
    }
    const guides: SnapGuide[] = [];
    if (gx) {
      guides.push({
        axis: 'x',
        at: gx.at,
        from: Math.min(sy, gx.r.y),
        to: Math.max(sy + h, gx.r.y + gx.r.h),
      });
    }
    if (gy) {
      guides.push({
        axis: 'y',
        at: gy.at,
        from: Math.min(sx, gy.r.x),
        to: Math.max(sx + w, gy.r.x + gy.r.w),
      });
    }
    return { x: sx, y: sy, guides };
  };

  // Publish drag guides only when they actually change (a serialized signature),
  // so a steady drag doesn't re-render the stage every frame.
  const setGuidesIfChanged = (guides: SnapGuide[]) => {
    const sig = guides
      .map((g) => `${g.axis}:${Math.round(g.at)}:${Math.round(g.from)}:${Math.round(g.to)}`)
      .join('|');
    if (sig !== dragGuidesSigRef.current) {
      dragGuidesSigRef.current = sig;
      setDragGuides(guides);
    }
  };
  const clearGuides = () => {
    if (dragGuidesSigRef.current !== '') {
      dragGuidesSigRef.current = '';
      setDragGuides([]);
    }
  };

  // Card header drag, painted STRAIGHT to the DOM (no store write / re-render until
  // release) — the perf path mirroring the canvas pan + section fixes. Snap (single)
  // and group-delta (multi) are unchanged; only WHERE the result lands moves: the
  // card elements during the drag, the store once on drop.
  const cardDragRef = useRef<{
    key: string;
    multi: boolean;
    cards: { key: string; el: HTMLElement | null; ox: number; oy: number }[];
    pos: Record<string, { x: number; y: number }>;
  } | null>(null);
  // Smoothed drag velocity (canvas px/ms) for the card fling, and the settle rAF.
  const cardVelRef = useRef<{ x: number; y: number; t: number; vx: number; vy: number } | null>(null);
  const cardFlingRaf = useRef<number | null>(null);
  type CardDrag = NonNullable<typeof cardDragRef.current>;

  const paintCardDrag = () => {
    const d = cardDragRef.current;
    if (!d) return;
    for (const c of d.cards) {
      const p = d.pos[c.key];
      if (c.el && p) {
        c.el.style.left = `${p.x}px`;
        c.el.style.top = `${p.y}px`;
      }
    }
  };

  // Write the dragged set's final positions to the store in ONE update; React
  // then owns the positions again, matching what we painted (no snap-back).
  const flushCardDrag = (d: CardDrag) => {
    cardDragRef.current = null;
    cardVelRef.current = null;
    clearGuides();
    const store = useCanvasStore.getState();
    const origin = d.cards.find((c) => c.key === d.key);
    const last = d.pos[d.key];
    if (!origin || !last) return;
    if (last.x === origin.ox && last.y === origin.oy) return; // a click that didn't move
    if (d.multi) {
      const base = Object.fromEntries(d.cards.map((c) => [c.key, { x: c.ox, y: c.oy }]));
      store.moveSelectionBy(
        d.cards.map((c) => c.key),
        base,
        last.x - origin.ox,
        last.y - origin.oy,
      );
    } else {
      store.setPos(d.key, last.x, last.y);
    }
  };

  // Card fling: a fast release throws the card(s) a little further and settles
  // with an easeOutBack overshoot (pane DESIGN §15 gesture spring), painted
  // straight to the DOM, then flushed to the store. The whole set shares one
  // throw delta; commitCardMove gates on speed + reduced-motion.
  const startCardFling = (d: CardDrag, vx: number, vy: number) => {
    const THROW = 120; // ms of velocity projected into a throw distance
    const CAP = 600; // canvas px — don't hurl a card off into space
    const tdx = Math.max(-CAP, Math.min(CAP, vx * THROW));
    const tdy = Math.max(-CAP, Math.min(CAP, vy * THROW));
    const startPos: Record<string, { x: number; y: number }> = {};
    const targetPos: Record<string, { x: number; y: number }> = {};
    for (const c of d.cards) {
      const s = d.pos[c.key] ?? { x: c.ox, y: c.oy };
      startPos[c.key] = { x: s.x, y: s.y };
      targetPos[c.key] = { x: s.x + tdx, y: s.y + tdy };
    }
    const DURATION = 460;
    let startTime = -1;
    const step = (now: number) => {
      if (startTime < 0) startTime = now;
      const t = Math.min(1, (now - startTime) / DURATION);
      const k = easeOutBack(t);
      for (const c of d.cards) {
        const s = startPos[c.key];
        const tg = targetPos[c.key];
        d.pos[c.key] = { x: s.x + (tg.x - s.x) * k, y: s.y + (tg.y - s.y) * k };
      }
      paintCardDrag();
      if (t < 1) {
        cardFlingRaf.current = requestAnimationFrame(step);
        return;
      }
      for (const c of d.cards) d.pos[c.key] = targetPos[c.key];
      paintCardDrag();
      cardFlingRaf.current = null;
      flushCardDrag(d);
    };
    cardFlingRaf.current = requestAnimationFrame(step);
  };

  const handleMove = (key: string, x: number, y: number, t?: number) => {
    // A new drag interrupts a settling fling — bank its progress first so the
    // fresh drag starts from where the card actually is.
    if (cardFlingRaf.current != null) {
      cancelAnimationFrame(cardFlingRaf.current);
      cardFlingRaf.current = null;
      if (cardDragRef.current) flushCardDrag(cardDragRef.current);
    }
    const store = useCanvasStore.getState();
    let d = cardDragRef.current;
    if (!d || d.key !== key) {
      // Starting a card drag ends any canvas fling and freezes the viewport, so
      // the drag maps the pointer against a stable camera.
      commitLive();
      const sel = store.selection;
      const multi = sel.length > 1 && sel.includes(key);
      const keys = multi ? sel : [key];
      const cards = keys
        .map((k) => {
          const r = store.placements[k];
          if (!r || r.locked) return null;
          return { key: k, el: document.querySelector<HTMLElement>(`[data-place-key="${k}"]`), ox: r.x, oy: r.y };
        })
        .filter((c): c is { key: string; el: HTMLElement | null; ox: number; oy: number } => !!c);
      d = { key, multi, cards, pos: {} };
      cardDragRef.current = d;
      cardVelRef.current = t != null ? { x, y, t, vx: 0, vy: 0 } : null;
    } else if (t != null) {
      const cv = cardVelRef.current;
      if (cv) {
        const dt = Math.max(1, t - cv.t);
        cv.vx = cv.vx * 0.6 + ((x - cv.x) / dt) * 0.4;
        cv.vy = cv.vy * 0.6 + ((y - cv.y) / dt) * 0.4;
        cv.x = x;
        cv.y = y;
        cv.t = t;
      } else {
        cardVelRef.current = { x, y, t, vx: 0, vy: 0 };
      }
    }
    if (d.multi) {
      const origin = d.cards.find((c) => c.key === key);
      if (!origin) return;
      // Snap the grabbed card against cards OUTSIDE the selection (a fellow-
      // selected card is moving too, so it's not a valid anchor), then shift the
      // whole selection by the snapped delta.
      const selSet = new Set(d.cards.map((c) => c.key));
      const snapped = computeSnap(key, x, y, selSet);
      const dx = snapped.x - origin.ox;
      const dy = snapped.y - origin.oy;
      for (const c of d.cards) d.pos[c.key] = { x: c.ox + dx, y: c.oy + dy };
      setGuidesIfChanged(snapped.guides);
    } else {
      const snapped = computeSnap(key, x, y);
      d.pos[key] = { x: snapped.x, y: snapped.y };
      setGuidesIfChanged(snapped.guides);
    }
    paintCardDrag();
  };

  // Release: a fast flick flings the card(s) with an overshoot settle, otherwise
  // commit immediately. `t` is the pointerup timestamp (for a freshness check).
  const commitCardMove = (t?: number) => {
    clearGuides(); // the snap is committed — drop the live guide lines
    const d = cardDragRef.current;
    if (!d) return;
    const origin = d.cards.find((c) => c.key === d.key);
    const last = d.pos[d.key];
    const cv = cardVelRef.current;
    const moved = !!origin && !!last && (last.x !== origin.ox || last.y !== origin.oy);
    const fresh = !!cv && t != null && t - cv.t <= 80;
    const speed = cv ? Math.hypot(cv.vx, cv.vy) : 0;
    if (moved && fresh && cv && speed > 0.4 && !prefersReducedMotion()) {
      startCardFling(d, cv.vx, cv.vy);
      return; // the fling flushes to the store when it settles
    }
    flushCardDrag(d);
  };

  // Re-assert an in-flight card drag after any incidental re-render (e.g. the
  // merge-highlight setState) so the dragged card never snaps to its stale store
  // position for a frame. Declared after the helpers so the rule sees the ref.
  useLayoutEffect(() => {
    if (cardDragRef.current) paintCardDrag();
  });

  // Cancel a settling card fling if the canvas unmounts mid-throw. Declared after
  // the helpers that modify the ref (react-hooks/immutability ordering).
  useEffect(
    () => () => {
      if (cardFlingRaf.current != null) cancelAnimationFrame(cardFlingRaf.current);
    },
    [],
  );

  // Keyboard arrow nudge (free, no snap): when the card is part of a multi-
  // selection, move the WHOLE selection by the same delta; otherwise just it.
  const handleNudge = (key: string, x: number, y: number) => {
    const store = useCanvasStore.getState();
    const sel = store.selection;
    if (sel.length > 1 && sel.includes(key)) {
      const cur = store.placements[key];
      if (!cur) return;
      const base: Record<string, { x: number; y: number }> = {};
      for (const k of sel) {
        const r = store.placements[k];
        if (r) base[k] = { x: r.x, y: r.y };
      }
      store.moveSelectionBy(sel, base, x - cur.x, y - cur.y);
    } else {
      store.setPos(key, x, y);
    }
  };

  // Card click: shift toggles the multi-selection; a plain click keeps an existing
  // multi-selection that includes this card (so a drag moves the group), else
  // selects just this one. Always focuses + raises it.
  const handleCardSelect = (tabId: string, key: string, additive?: boolean) => {
    const store = useCanvasStore.getState();
    if (additive) {
      store.toggleSelection(key);
    } else if (!store.selection.includes(key)) {
      store.setSelection([key]);
    }
    focusCard(tabId, key);
  };

  // Placement keys for every card currently rendered (ungrouped visible tabs +
  // visible groups) — read fresh so it's safe from a []-dep keyboard handler.
  const renderedKeys = (): string[] => {
    const cs = useCanvasStore.getState();
    const isRendered = renderedPredicate(visibleTabIds(), cs.groups);
    return Object.keys(cs.placements).filter(isRendered);
  };

  // Close every selected card (a group key closes all its member tabs).
  const closeSelection = (): void => {
    const cs = useCanvasStore.getState();
    if (cs.selection.length === 0) return;
    const tabsStore = useTabsStore.getState();
    for (const key of cs.selection) {
      const grp = cs.groups.find((g) => g.id === key);
      if (grp) for (const id of grp.tabIds) void tabsStore.closeTab(id);
      else void tabsStore.closeTab(key);
    }
    cs.clearSelection();
  };

  // Use the tracked container `size` (not the ref) so these stay callable from
  // render-built menu items without reading a ref during render.
  // The +/- buttons step zoom synchronously (one click = one discrete step, so
  // no need to ease), settling any in-flight wheel gesture first so the step lands
  // on the real committed viewport.
  const zoomFromCenter = (factor: number) => {
    commitLive();
    useCanvasStore.getState().zoomAt(factor, size.w / 2, size.h / 2);
  };
  // Fit / reset glide the camera with an eased tween (ported pane easing —
  // reference/pane-porting-map.md §D) instead of snapping to the new pose.
  const fit = () => {
    const st = useCanvasStore.getState();
    st.animateTo(st.getFitPose(size.w, size.h));
  };
  const animateReset = () =>
    useCanvasStore.getState().animateTo({ panX: 0, panY: 0, scale: 1 });
  // The current visible viewport as a canvas-space rect (for maximize), inset a
  // little so a maximized card doesn't butt against the very edges.
  const maximizeRect = () => {
    const { panX, panY, scale } = useCanvasStore.getState().viewport;
    const pad = 24 / scale;
    return {
      x: -panX / scale + pad,
      y: -panY / scale + pad,
      w: Math.max(120, size.w / scale - pad * 2),
      h: Math.max(80, size.h / scale - pad * 2),
    };
  };

  // Screen px → canvas coords (inverse of the plane's translate+scale). During a
  // live pan/zoom the plane is painted from `liveRef`, so map against that (else
  // the committed store value) — keeps a cursor placement landing under the cursor
  // even mid-gesture, when the store viewport is intentionally stale.
  const toCanvas = useCallback((clientX: number, clientY: number) => {
    const el = containerRef.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    const { panX, panY, scale } = liveRef.current ?? useCanvasStore.getState().viewport;
    return { x: (clientX - r.left - panX) / scale, y: (clientY - r.top - panY) / scale };
  }, []);

  // Drag a connection from a card OR section port to another node. Window
  // listeners (the drag crosses the whole canvas); the drop target is hit-tested
  // by geometry. `fromNode` is a tab id or a section id.
  const startConnect = useCallback(
    (fromNode: string, fromSide: EdgeSide, clientX: number, clientY: number) => {
      const p = toCanvas(clientX, clientY);
      setConnect({ from: fromNode, fromSide, x: p.x, y: p.y });
      const onMove = (ev: PointerEvent) => {
        const q = toCanvas(ev.clientX, ev.clientY);
        setConnect((c) => (c ? { ...c, x: q.x, y: q.y } : c));
      };
      const onUp = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        setConnect(null);
        // Geometry hit-test, NOT document.elementFromPoint: a web card's native
        // WebContentsView composites over the React body, so elementFromPoint
        // would return that view and the drop would be lost. Find the topmost
        // visible card/group whose rect contains the drop point.
        const pt = toCanvas(ev.clientX, ev.clientY);
        const { placements: pl, groups: gs, sections: secs } = useCanvasStore.getState();
        const fromKey = placementKey(gs, fromNode);
        const visSet = visibleTabIds();
        let targetTabId: string | null = null;
        let targetRect: CardRect | null = null;
        let bestZ = -Infinity;
        for (const [key, r] of Object.entries(pl)) {
          if (key === fromKey) continue;
          const grp = gs.find((g) => g.id === key);
          const visible = grp ? grp.tabIds.some((id) => visSet.has(id)) : visSet.has(key);
          if (!visible) continue;
          if (pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h && r.z > bestZ) {
            bestZ = r.z;
            // A group target connects to its active member (edges are tab-keyed).
            targetTabId = grp ? grp.activeId : key;
            targetRect = r;
          }
        }
        // No card under the drop → fall back to a section (drawn behind cards), so
        // you can wire a section by dropping on its empty area. Prefer the SMALLEST
        // containing section so a nested inner section wins over its parent.
        if (!targetTabId) {
          let bestArea = Infinity;
          for (const sec of secs) {
            if (sec.id === fromKey) continue;
            if (pt.x >= sec.x && pt.x <= sec.x + sec.w && pt.y >= sec.y && pt.y <= sec.y + sec.h) {
              const area = sec.w * sec.h;
              if (area < bestArea) {
                bestArea = area;
                targetTabId = sec.id;
                targetRect = { x: sec.x, y: sec.y, w: sec.w, h: sec.h, z: 0 };
              }
            }
          }
        }
        // Pin the target end to the face nearest the drop point (4-directional).
        if (targetTabId && targetRect) {
          useCanvasStore.getState().addEdge(fromNode, targetTabId, fromSide, nearestSide(targetRect, pt));
        }
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [toCanvas],
  );

  // Drag-to-merge: the topmost OTHER card/group whose HEADER band sits under the
  // drop point — a narrow band (≈ header height) so a merge is intentional, not
  // triggered by overlapping bodies. Returns its placement key, or null.
  const mergeHitTest = (draggedKey: string, clientX: number, clientY: number): string | null => {
    const pt = toCanvas(clientX, clientY);
    const { placements: pl } = useCanvasStore.getState();
    let target: string | null = null;
    let bestZ = -Infinity;
    for (const [key, r] of Object.entries(pl)) {
      if (key === draggedKey) continue;
      if (pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + 44 && r.z > bestZ) {
        bestZ = r.z;
        target = key;
      }
    }
    return target;
  };
  // Only ungrouped cards report these (their key === tab id), so dragging a card
  // onto another card/group merges it; dragging a group just moves it.
  const headerDragMove = (draggedTabId: string, cx: number, cy: number) => {
    setMergeTarget(mergeHitTest(draggedTabId, cx, cy));
  };
  const headerDrop = (draggedTabId: string, cx: number, cy: number) => {
    const t = mergeHitTest(draggedTabId, cx, cy);
    setMergeTarget(null);
    if (t) useCanvasStore.getState().mergeInto(t, draggedTabId);
  };

  // Resolve a group's members into the tab-strip shape CanvasCard renders.
  const groupProps = (groupId: string): CardGroupProps | undefined => {
    const g = groups.find((gr) => gr.id === groupId);
    if (!g) return undefined;
    const members = g.tabIds
      .map((id) => tabs.find((tb) => tb.id === id))
      .filter((tb): tb is TabState => !!tb)
      .map((tb) => ({
        id: tb.id,
        title: tb.title?.trim() || tabKinds[tb.kind]?.title || t('canvas.tabFallback'),
        icon: tabKinds[tb.kind]?.icon ?? Globe,
      }));
    return {
      members,
      activeId: g.activeId,
      onSelect: (tabId) => {
        useCanvasStore.getState().setGroupActive(g.id, tabId);
        focusCard(tabId, g.id);
      },
      onCloseMember: (tabId) => void useTabsStore.getState().closeTab(tabId),
    };
  };

  // Recenter the viewport on a canvas point (minimap click). Uses `size` state
  // rather than the container ref so it's safe to build from render.
  const centerOn = (wx: number, wy: number) => {
    const { scale } = useCanvasStore.getState().viewport;
    useCanvasStore.getState().setPan(size.w / 2 - wx * scale, size.h / 2 - wy * scale);
  };

  // Frame a single card: glide the camera so the card fills the viewport (the
  // "focus a pane" camera command — pane CANVAS.md §6, reuses the ported
  // fitPose + animateTo tween). Uses `size` state (like centerOn) so it's safe
  // to build from render (the card menu is rendered).
  const frameCard = (placeKey: string) => {
    const st = useCanvasStore.getState();
    const r = st.placements[placeKey];
    if (!r) return;
    st.animateTo(
      fitPose([r], { width: size.w, height: size.h }, { padding: 80, titleH: 28 }),
    );
  };

  // Zoom the camera to fit the current multi-selection (Figma "zoom to selection",
  // Shift+2). Falls back to the focused card so a lone card still frames.
  const frameSelection = () => {
    const st = useCanvasStore.getState();
    const keys = st.selection.length > 0 ? st.selection : st.focusedTabId ? [keyOf(st.focusedTabId)] : [];
    const rects = keys.map((k) => st.placements[k]).filter((r): r is CardRect => !!r);
    if (rects.length === 0) return;
    st.animateTo(fitPose(rects, { width: size.w, height: size.h }, { padding: 80, titleH: 28 }));
  };
  // Latest-value ref so the (intentionally minimal-dep) keydown effect calls the
  // current frameSelection — which closes over `size` — without re-subscribing.
  const frameSelectionRef = useRef(frameSelection);
  useLayoutEffect(() => {
    frameSelectionRef.current = frameSelection;
  });

  // Align/distribute + zoom-to-selection menu items, shown when 2+ cards are
  // selected (Figma-style). Shared by the canvas and card context menus.
  const alignDistributeItems = (): MenuItem[] => {
    const store = useCanvasStore.getState();
    const n = store.selection.filter((k) => store.placements[k]).length;
    if (n < 2) return [];
    const items: MenuItem[] = [
      { type: 'separator' },
      { label: t('canvas.menu.alignLeft'), onSelect: () => store.alignSelection('left') },
      { label: t('canvas.menu.alignHCenter'), onSelect: () => store.alignSelection('hcenter') },
      { label: t('canvas.menu.alignRight'), onSelect: () => store.alignSelection('right') },
      { label: t('canvas.menu.alignTop'), onSelect: () => store.alignSelection('top') },
      { label: t('canvas.menu.alignVCenter'), onSelect: () => store.alignSelection('vcenter') },
      { label: t('canvas.menu.alignBottom'), onSelect: () => store.alignSelection('bottom') },
    ];
    if (n >= 3) {
      items.push(
        { label: t('canvas.menu.distributeH'), onSelect: () => store.distributeSelection('h') },
        { label: t('canvas.menu.distributeV'), onSelect: () => store.distributeSelection('v') },
      );
    }
    items.push({ label: t('canvas.menu.zoomToSelection'), onSelect: () => frameSelection() });
    return items;
  };

  // A spot for a NEW card with no explicit drop point (the toolbar button): the
  // first free grid cell inside the visible viewport, so it always lands on-screen
  // (not at the off-screen canvas origin when panned away) AND doesn't stack on an
  // existing card. Pending spawns are counted too, so rapid clicks don't collide.
  const placeInView = useCallback(
    (kind: TabKind): { x: number; y: number; w: number; h: number } => {
      const cs = useCanvasStore.getState();
      // Prefer the in-flight live viewport (a pan/zoom may not have committed yet)
      // so a card created right after a wheel pan still lands in the visible area,
      // not at the stale (pre-pan) viewport the store still holds.
      const { panX, panY, scale } = liveRef.current ?? cs.viewport;
      const { w, h } = cardDefaultSize(kind);
      const inset = 36 / scale;
      const vx = -panX / scale + inset;
      const vy = -panY / scale + inset;
      // Live container size from the ref, so this stays correct without a `size` dep.
      const rect = containerRef.current?.getBoundingClientRect();
      const viewW = (rect?.width ?? 1200) / scale;
      const viewH = (rect?.height ?? 800) / scale;
      const occupied = [
        ...Object.values(cs.placements),
        ...Object.values(cs.pendingPlacements),
      ];
      const free = (x: number, y: number) =>
        !occupied.some((r) => x < r.x + r.w && x + w > r.x && y < r.y + r.h && y + h > r.y);
      // Fine-step raster scan for the first fully-on-screen spot that overlaps no
      // existing card — a coarse card-width grid missed every gap when a wide card
      // sat in the way, then cascaded into an overlap.
      const step = 48;
      const maxX = vx + Math.max(0, viewW - w);
      const maxY = vy + Math.max(0, viewH - h);
      for (let y = vy; y <= maxY + 0.5; y += step) {
        for (let x = vx; x <= maxX + 0.5; x += step) {
          if (free(x, y)) return { x: Math.round(x), y: Math.round(y), w, h };
        }
      }
      // Nothing fits on-screen without overlap → top-left of the view (still
      // visible; some overlap is unavoidable when the viewport is packed).
      return { x: Math.round(vx), y: Math.round(vy), w, h };
    },
    [],
  );

  const newCard = useCallback(
    (kind: TabKind = 'home', at?: { x: number; y: number }) => {
      void (async () => {
        // Use the id main returns — NOT activeTabId read back, which is stale
        // until the coalesced tabs-state push lands a tick later (that race
        // moved the *previous* card to the cursor and grid-placed the new one).
        const id = await useTabsStore.getState().newTab(kind, undefined, activeWorkspaceId ?? undefined);
        if (!id) return;
        const store = useCanvasStore.getState();
        // Centered on the cursor / drop point when given one (right-click +
        // double-click); otherwise the first free on-screen grid cell. Either way
        // the card lands directly (no grid-then-jump) via placeNext.
        if (at) {
          const { w, h } = cardDefaultSize(kind);
          store.placeNext(id, { x: Math.round(at.x - w / 2), y: Math.round(at.y - h / 2), w, h });
        } else {
          store.placeNext(id, placeInView(kind));
        }
        // Focus the new card so it's the live surface immediately.
        raiseWhenPlaced(id);
      })();
    },
    [activeWorkspaceId, placeInView],
  );

  // Open DevTools for a web card as a canvas card (the 'devtools' tab kind),
  // not the pop-out window — focus an existing one bound to this web tab, else
  // create one. The new card is placed by syncPlacements; we focus + raise it.
  const openDevtoolsFor = useCallback(
    (webTabId: string) => {
      void (async () => {
        const tabsStore = useTabsStore.getState();
        const existing = tabsStore.tabs.find(
          (t) => t.kind === 'devtools' && t.devtoolsTargetTabId === webTabId,
        );
        let id: string | null;
        if (existing) {
          await tabsStore.activateTab(existing.id);
          id = existing.id;
        } else {
          // Use the returned id — activeTabId is stale until the next-tick push.
          const newId = await window.marudesk.invoke('browser:tabs-new', {
            kind: 'devtools',
            devtoolsTargetTabId: webTabId,
            ...(activeWorkspaceId ? { workspaceId: activeWorkspaceId } : {}),
          });
          id = typeof newId === 'string' ? newId : null;
        }
        if (!id) return;
        const tabId = id;
        raiseWhenPlaced(tabId);
      })();
    },
    [activeWorkspaceId],
  );

  // "Save current as a new canvas": open a new canvas and recreate the open
  // canvas's panels as fresh tabs at the same coordinates (+ its edges). Grouped
  // cards are flattened to a small cascade. The originals stay on their canvas.
  const duplicateCanvas = (sourceName: string) => {
    void (async () => {
      const cs = useCanvasStore.getState();
      const placements = { ...cs.placements };
      const groups = cs.groups.map((g) => ({ ...g }));
      const edges = cs.edges.map((e) => ({ ...e }));
      // Sections are tab-independent geometry, so a faithful duplicate just copies
      // them verbatim (ids stay unique within the new canvas's own list).
      const sections = cs.sections.map((sec) => ({ ...sec }));
      // A faithful copy keeps the same view + wire style, not just card rects.
      const sourceViewport = { ...cs.viewport };
      const sourceEdgeStyle = cs.edgeStyle;
      const tabsById = new Map(useTabsStore.getState().tabs.map((t) => [t.id, t] as const));
      const ws = activeWorkspaceId ?? undefined;

      // Flatten placements into (oldTabId → target rect) entries.
      const entries: { oldId: string; rect: CardRect }[] = [];
      for (const [key, rect] of Object.entries(placements)) {
        const grp = groups.find((g) => g.id === key);
        if (grp) grp.tabIds.forEach((id, i) => entries.push({ oldId: id, rect: { ...rect, x: rect.x + i * 28, y: rect.y + i * 28 } }));
        else entries.push({ oldId: key, rect });
      }

      useCanvasStore.getState().newCanvas(`${sourceName} copy`);
      // Open the copy on the same view + edge style + sections as the source so it
      // looks identical, not reset to the origin at 100%.
      useCanvasStore.setState({ viewport: sourceViewport, edgeStyle: sourceEdgeStyle, sections });

      const idMap = new Map<string, string>();
      const newIds: string[] = [];
      for (const { oldId, rect } of entries) {
        const tab = tabsById.get(oldId);
        if (!tab) continue;
        const newId = await window.marudesk.invoke('browser:tabs-new', tabToNewTabPayload(tab, ws));
        if (typeof newId !== 'string') continue;
        idMap.set(oldId, newId);
        newIds.push(newId);
        // Spawn each copy at its source rect. setPos/setSize would no-op here —
        // the new tab isn't in the store yet — so register the rect for the card
        // to adopt the instant it appears.
        useCanvasStore.getState().placeNext(newId, { x: rect.x, y: rect.y, w: rect.w, h: rect.h });
      }
      // Edges reference live placements, so only wire them once every copied card
      // has landed (addEdge no-ops on a missing endpoint).
      await waitForPlacements(newIds);
      for (const e of edges) {
        const from = idMap.get(e.from);
        const to = idMap.get(e.to);
        if (from && to) useCanvasStore.getState().addEdge(from, to, e.fromSide, e.toSide);
      }
    })();
  };

  // Delete a canvas and close the panels that lived on it: a canvas owns its
  // panels, so orphaned tabs would otherwise be re-adopted by the open canvas.
  const deleteCanvas = (id: string) => {
    const closeIds = useCanvasStore.getState().deleteCanvas(id);
    const tabsStore = useTabsStore.getState();
    for (const tid of closeIds) void tabsStore.closeTab(tid);
  };

  // The canvas switcher menu: switch between this workspace's named canvases
  // (= saved layouts) and manage them.
  const canvasMenuItems = (): MenuItem[] => {
    const items: MenuItem[] = canvasList.map((c) => ({
      label: c.name,
      icon: c.id === activeCanvasId ? <Check size={14} /> : undefined,
      onSelect: () => useCanvasStore.getState().switchCanvas(c.id),
    }));
    items.push(
      { type: 'separator' },
      { label: t('canvas.dialog.newCanvas'), icon: <Plus size={14} />, onSelect: () => setNameDialog({ mode: 'new' }) },
      {
        label: t('canvas.dialog.renameCanvas'),
        icon: <Pencil size={14} />,
        onSelect: () => setNameDialog({ mode: 'rename', id: activeCanvasId, initial: activeCanvasName }),
      },
      {
        label: t('canvas.dialog.duplicateCanvas'),
        icon: <CopyPlus size={14} />,
        onSelect: () => duplicateCanvas(activeCanvasName),
      },
      {
        label: t('canvas.dialog.deleteCanvas'),
        icon: <Trash2 size={14} />,
        danger: true,
        disabled: canvasList.length <= 1,
        onSelect: () => deleteCanvas(activeCanvasId),
      },
    );
    return items;
  };

  // Right-click: a context menu for the edge / card-header / empty canvas under
  // the cursor. Right-clicking a card BODY is left to the surface (Monaco, xterm,
  // a web page) so its own menu still works — only the card header opens the card
  // menu.
  const onContextMenu = (e: ReactMouseEvent<HTMLDivElement>) => {
    commitLive(); // a context-menu open ends any in-flight fling
    const t = e.target as HTMLElement;
    const edgeEl = t.closest('[data-edge-id]');
    if (edgeEl) {
      e.preventDefault();
      const edgeId = edgeEl.getAttribute('data-edge-id') ?? '';
      // Select it too, so the wire highlights and the delete control appears —
      // the menu and the visual selection should agree on the target.
      useCanvasStore.getState().selectEdge(edgeId);
      setMenu({ x: e.clientX, y: e.clientY, kind: 'edge', edgeId });
      return;
    }
    const headerEl = t.closest('[data-card-header]');
    if (headerEl) {
      // A right-click on a specific group member chip targets THAT member, not
      // the active one; otherwise the card's own tab id.
      const chipId = (t.closest('[data-member-tab-id]') as HTMLElement | null)?.getAttribute(
        'data-member-tab-id',
      );
      const id = chipId ?? headerEl.closest('[data-tab-id]')?.getAttribute('data-tab-id');
      if (id) {
        e.preventDefault();
        focusCard(id, keyOf(id));
        setMenu({ x: e.clientX, y: e.clientY, kind: 'card', tabId: id });
        return;
      }
    }
    // Frame chrome (resize handles / connection ports) sits on the card root but
    // outside the body surface — open the card menu for it rather than letting
    // the native OS context menu show (no preventDefault otherwise).
    const cardRoot = t.closest('[data-tab-id]');
    if (cardRoot && t.closest('[data-resize-dir], [aria-label^="Connect from"]')) {
      const id = cardRoot.getAttribute('data-tab-id');
      if (id) {
        e.preventDefault();
        focusCard(id, keyOf(id));
        setMenu({ x: e.clientX, y: e.clientY, kind: 'card', tabId: id });
        return;
      }
    }
    // Inside a card body → let the surface's own context menu handle it.
    if (t.closest('[data-canvas-card]')) return;
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, kind: 'canvas' });
  };

  // Double-click empty canvas creates a card (Figma-style).
  const onDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    // Double-click a card's title bar → frame it (zoom the camera to the card).
    const header = target.closest('[data-card-header]');
    if (header) {
      const id = header.closest('[data-tab-id]')?.getAttribute('data-tab-id');
      if (id) {
        frameCard(keyOf(id));
        return;
      }
    }
    if (target.closest('[data-canvas-card], [data-canvas-section], button, [data-edge-id]')) return;
    newCard('home', toCanvas(e.clientX, e.clientY));
  };

  const menuItems = (m: CanvasMenu): MenuItem[] => {
    const store = useCanvasStore.getState();
    if (m.kind === 'edge') {
      return [
        {
          label: edgeStyle === 'curve' ? t('canvas.edge.square') : t('canvas.edge.curved'),
          onSelect: () => store.toggleEdgeStyle(),
        },
        { type: 'separator' },
        { label: t('canvas.edge.remove'), danger: true, onSelect: () => store.removeEdge(m.edgeId) },
      ];
    }
    if (m.kind === 'card') {
      const tab = tabs.find((t) => t.id === m.tabId);
      // For a grouped card the placement key is the group id; raise/lower that.
      const placeKey = keyOf(m.tabId);
      const inGroup = placeKey !== m.tabId;
      const rect = placements[placeKey];
      const items: MenuItem[] = [
        { label: t('canvas.menu.zoomToCard'), onSelect: () => frameCard(placeKey) },
        { label: t('canvas.menu.bringFront'), onSelect: () => store.bringToFront(placeKey) },
        { label: t('canvas.menu.sendBack'), onSelect: () => store.sendToBack(placeKey) },
        {
          label: rect?.preMax ? t('canvas.menu.restoreSize') : t('canvas.card.maximize'),
          onSelect: () => store.toggleMaximize(placeKey, maximizeRect()),
        },
        { label: rect?.locked ? t('canvas.card.unlock') : t('canvas.card.lock'), onSelect: () => store.toggleLock(placeKey) },
      ];
      // Frame this card (or the whole multi-selection it's part of) in a section.
      const secKeys = selection.includes(placeKey) && selection.length > 1 ? selection : [placeKey];
      items.push({
        label: formatCanvasGroupSection(secKeys.length),
        icon: <Group size={14} />,
        onSelect: () => {
          store.addSection(secKeys);
          store.clearSelection();
        },
      });
      // Align/distribute when this card is part of a multi-selection.
      if (selection.includes(placeKey)) items.push(...alignDistributeItems());
      if (inGroup) {
        items.push({ label: t('canvas.menu.popOut'), onSelect: () => store.popOutTab(m.tabId) });
      }
      if (tab?.kind === 'web') {
        items.push(
          { type: 'separator' },
          {
            label: t('canvas.card.reload'),
            onSelect: () =>
              void (async () => {
                await useTabsStore.getState().activateTab(m.tabId);
                await window.marudesk.invoke('browser:reload');
              })(),
          },
          {
            label: t('canvas.card.devtools'),
            onSelect: () => openDevtoolsFor(m.tabId),
          },
          {
            label: t('canvas.menu.copyLink'),
            disabled: !tab.url,
            onSelect: () => void window.marudesk.invoke('clipboard:write-text', tab.url),
          },
        );
      }
      items.push(
        { type: 'separator' },
        { label: t('canvas.card.close'), danger: true, onSelect: () => void useTabsStore.getState().closeTab(m.tabId) },
      );
      return items;
    }
    return [
      ...(selection.length > 0
        ? [
            {
              label: formatCanvasGroupSection(selection.length),
              icon: <Group size={14} />,
              onSelect: () => {
                store.addSection(selection);
                store.clearSelection();
              },
            },
            ...alignDistributeItems(),
            { type: 'separator' as const },
          ]
        : []),
      { label: t('canvas.menu.newBrowserTab'), onSelect: () => newCard('web', toCanvas(m.x, m.y)) },
      { label: t('canvas.menu.newTerminal'), onSelect: () => newCard('terminal', toCanvas(m.x, m.y)) },
      { label: t('canvas.menu.newEditor'), onSelect: () => newCard('editor', toCanvas(m.x, m.y)) },
      { label: t('canvas.menu.newAiChat'), onSelect: () => newCard('agent', toCanvas(m.x, m.y)) },
      { label: t('canvas.menu.newNote'), icon: <StickyNote size={14} />, onSelect: () => useCanvasStore.getState().addNote(toCanvas(m.x, m.y)) },
      { type: 'separator' },
      { label: t('canvas.control.fit'), onSelect: () => fit() },
      { label: t('canvas.menu.resetZoom'), onSelect: () => animateReset() },
      { label: t('canvas.menu.arrange'), onSelect: () => store.arrangeCards() },
      { type: 'separator' },
      {
        label: edgeStyle === 'curve' ? t('canvas.edge.square') : t('canvas.edge.curved'),
        onSelect: () => store.toggleEdgeStyle(),
      },
      { label: minimapOpen ? t('canvas.minimapHide') : t('canvas.minimapShow'), onSelect: () => setMinimapOpen((v) => !v) },
      { label: planFlowOpen ? t('agent.flow.hide') : t('agent.flow.show'), onSelect: () => setPlanFlowOpen((v) => !v) },
    ];
  };

  // Canvas keyboard (Figma-style): ⌘/Ctrl+Shift+M minimap; Space holds pan; ⌘/Ctrl+A
  // select all; Esc clears; Delete removes the selected edge or closes the
  // selection. All gated off text fields / controls.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const editable =
        !!t &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.isContentEditable ||
          !!t.closest('input, textarea, [contenteditable], button'));
      // A focused canvas card owns the arrow keys (it nudges itself). Without this
      // the global camera handler ALSO pans, so the card and viewport fight — the
      // card moves +8px while the canvas pans -80px. Arrow-pan is for the unfocused
      // canvas only; +/-/0/F have no card binding so they stay live either way.
      const onCard = !!t?.closest('[data-canvas-card]');
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        setMinimapOpen((v) => !v);
        return;
      }
      // `?` (Shift+/) — the canvas keymap cheat-sheet. Gated off text fields.
      if (e.key === '?' && !editable) {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
        return;
      }
      if (e.code === 'Space' && !editable) {
        if (!spaceDownRef.current) {
          spaceDownRef.current = true;
          setSpacePan(true);
        }
        e.preventDefault();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !editable) {
        e.preventDefault();
        useCanvasStore.getState().setSelection(renderedKeys());
        return;
      }
      if (e.key === 'Escape' && !editable) {
        const cs = useCanvasStore.getState();
        cs.clearSelection();
        cs.setFocused(null);
        cs.selectEdge(null);
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !editable) {
        const cs = useCanvasStore.getState();
        if (cs.selectedEdgeId) {
          e.preventDefault();
          cs.removeEdge(cs.selectedEdgeId);
        } else if (cs.selection.length > 0) {
          e.preventDefault();
          closeSelection();
        }
        return;
      }
      // Camera commands (ported from pane's canvas keymap — CANVAS.md §6):
      // +/- zoom about center, 0 reset, F fit-all, arrows pan. Plain keys only,
      // so they never collide with page zoom (Ctrl±) or select-all (Ctrl/⌘+A).
      if (!editable && !e.ctrlKey && !e.metaKey && !e.altKey) {
        commitLive(); // fold any in-flight fling before a keyboard camera command
        const st = useCanvasStore.getState();
        const cr = containerRef.current?.getBoundingClientRect();
        // Shift+2 — zoom to selection (Figma parity). `code` is layout-independent
        // (Shift+2 emits '@' on US layouts).
        if (e.shiftKey && e.code === 'Digit2') {
          e.preventDefault();
          frameSelectionRef.current();
          return;
        }
        if (e.key === '+' || e.key === '=') {
          if (cr) {
            e.preventDefault();
            st.zoomAt(1.2, cr.width / 2, cr.height / 2);
          }
          return;
        }
        if (e.key === '-' || e.key === '_') {
          if (cr) {
            e.preventDefault();
            st.zoomAt(1 / 1.2, cr.width / 2, cr.height / 2);
          }
          return;
        }
        if (e.key === '0') {
          e.preventDefault();
          st.animateTo({ panX: 0, panY: 0, scale: 1 });
          return;
        }
        if (e.key === 'f' || e.key === 'F') {
          if (cr) {
            e.preventDefault();
            st.animateTo(st.getFitPose(cr.width, cr.height));
          }
          return;
        }
        if (!onCard) {
          const PAN = e.shiftKey ? 240 : 80;
          if (e.key === 'ArrowRight') { e.preventDefault(); st.panBy(-PAN, 0); return; }
          if (e.key === 'ArrowLeft') { e.preventDefault(); st.panBy(PAN, 0); return; }
          if (e.key === 'ArrowDown') { e.preventDefault(); st.panBy(0, -PAN); return; }
          if (e.key === 'ArrowUp') { e.preventDefault(); st.panBy(0, PAN); return; }
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceDownRef.current = false;
        setSpacePan(false);
      }
    };
    // A keyup can be missed if the window loses focus mid-hold (alt-tab while
    // Space is down), which would strand the canvas in pan-on-left-drag mode.
    // Reset the Space-pan latch on blur so the cursor/behavior recover.
    const onBlur = () => {
      if (spaceDownRef.current) {
        spaceDownRef.current = false;
        setSpacePan(false);
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
    // commitLive is a stable useCallback; listed so the camera keys always fold
    // an in-flight fling before acting.
  }, [commitLive]);

  // What to render: each ungrouped visible tab as a card, plus one card per group
  // (showing its active member with a tab strip). Grouped members aren't drawn
  // individually — the group owns the frame.
  const grouped = new Set(groups.flatMap((g) => g.tabIds));
  const cardItems: { key: string; tab: TabState; group?: CardGroupProps }[] = [];
  for (const tab of visibleTabs) {
    if (grouped.has(tab.id) || !placements[tab.id]) continue;
    cardItems.push({ key: tab.id, tab });
  }
  for (const g of groups) {
    if (!placements[g.id]) continue;
    const activeTab =
      visibleTabs.find((t) => t.id === g.activeId) ?? visibleTabs.find((t) => g.tabIds.includes(t.id));
    if (activeTab) cardItems.push({ key: g.id, tab: activeTab, group: groupProps(g.id) });
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        // `overflow-clip` (not `hidden`): the canvas pans via transform and must
        // never be a native scroll container — overflowing cards otherwise make
        // it programmatically scrollable, and a focus-driven scroll-to-0 fires a
        // spurious `scroll` event that dismisses on-canvas menus/popovers.
        'relative h-full w-full overflow-clip bg-surface-page',
        panning ? 'cursor-grabbing' : spacePan ? 'cursor-grab' : 'cursor-default',
      )}
      style={{
        backgroundImage: 'radial-gradient(var(--border-subtle) 1px, transparent 1.6px)',
        backgroundSize: `${24 * viewport.scale}px ${24 * viewport.scale}px`,
        backgroundPosition: `${viewport.panX}px ${viewport.panY}px`,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onContextMenu={onContextMenu}
      onDoubleClick={onDoubleClick}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(FILE_DND_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes(FILE_DND_MIME)) return;
        e.preventDefault();
        const payload = parseFileDrag(e.dataTransfer.getData(FILE_DND_MIME));
        if (!payload) return;
        const pt = toCanvas(e.clientX, e.clientY);
        void (async () => {
          const id = await openFileDragAsTab(payload);
          if (!id) return;
          const store = useCanvasStore.getState();
          // Dropped files open as editor cards — center one on the drop point.
          const { w, h } = cardDefaultSize('editor');
          store.placeNext(id, { x: Math.round(pt.x - w / 2), y: Math.round(pt.y - h / 2), w, h });
          raiseWhenPlaced(id);
        })();
      }}
      aria-label={t('canvas.label')}
      tabIndex={-1}
    >
      {cardItems.length === 0 && sections.length === 0 && notes.length === 0 ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="select-none text-center">
            <div className="text-body-sm text-fg-tertiary">{t('canvas.empty.title')}</div>
            <div className="mt-1 text-caption text-fg-tertiary/70">{t('canvas.empty.hint')}</div>
          </div>
        </div>
      ) : null}
      <div
        ref={planeRef}
        className="absolute inset-0 origin-top-left"
        style={{
          transform: `translate(${viewport.panX}px, ${viewport.panY}px) scale(${viewport.scale})`,
          // `will-change: transform` is toggled imperatively for the duration of a
          // pan/zoom gesture (seedLive → commitLive) so the plane is a GPU layer
          // while moving, then re-rasterizes at rest — keeping card text crisp when
          // idle instead of permanently scaling a frozen bitmap.
        }}
      >
        {/* Section frames, drawn behind everything (zIndex 0). */}
        <CanvasSections
          sections={sections}
          scale={viewport.scale}
          onStartConnect={(sectionId, side, cx, cy) => startConnect(sectionId, side, cx, cy)}
        />
        {/* Sticky notes — annotation layer above sections, beneath the cards. */}
        <CanvasNotes notes={notes} scale={viewport.scale} />
        {/* Node connections (card↔card, card↔section, section↔section). */}
        <CanvasEdges
          placements={nodeRects}
          edges={visibleEdges}
          edgeStyle={edgeStyle}
          selectedEdgeId={selectedEdgeId}
          preview={connect}
          onSelectEdge={(id) => useCanvasStore.getState().selectEdge(id)}
          keyOf={keyOf}
        />
        {cardItems.map(({ key, tab, group }) => {
          const rect = placements[key];
          if (!rect) return null;
          const isWeb = tab.kind === 'web';
          return (
            <CanvasCard
              key={key}
              tab={tab}
              placeKey={key}
              rect={rect}
              scale={viewport.scale}
              focused={focusedTabId === tab.id}
              group={group}
              mergeHighlight={mergeTarget === key}
              selected={selection.includes(key)}
              locked={rect.locked}
              maximized={!!rect.preMax}
              onToggleLock={() => useCanvasStore.getState().toggleLock(key)}
              onToggleMaximize={() => useCanvasStore.getState().toggleMaximize(key, maximizeRect())}
              onFocus={(additive) => handleCardSelect(tab.id, key, additive)}
              onClose={() => {
                void useTabsStore.getState().closeTab(tab.id);
                containerRef.current?.focus(); // keep keyboard focus on the canvas
              }}
              onMove={(x, y, t) => handleMove(key, x, y, t)}
              onMoveEnd={commitCardMove}
              onNudge={(x, y) => handleNudge(key, x, y)}
              onResize={(w, h) => useCanvasStore.getState().setSize(key, w, h)}
              // Merge only by dragging a single ungrouped card (its key === tab
              // id). Dragging a group, or a card that's part of a multi-selection,
              // just moves — otherwise a multi-card drag would silently swallow
              // one card into an unselected card under the drop point.
              onHeaderDragMove={
                group || (selection.length > 1 && selection.includes(key))
                  ? undefined
                  : (cx, cy) => headerDragMove(tab.id, cx, cy)
              }
              onHeaderDrop={
                group || (selection.length > 1 && selection.includes(key))
                  ? undefined
                  : (cx, cy) => headerDrop(tab.id, cx, cy)
              }
              registerWebEl={isWeb ? (el) => registerWebEl(tab.id, el) : undefined}
              onNavigate={
                isWeb
                  ? (input) => {
                      // Navigate THIS card's own view in place (by tab id) — never
                      // touches the active tab or the grid, so the page loads in the
                      // card instead of leaving it blank. Main normalizes URL vs.
                      // search term.
                      void window.marudesk.invoke('browser:navigate-tab', { tabId: tab.id, url: input });
                    }
                  : undefined
              }
              onGoBack={isWeb ? () => void window.marudesk.invoke('browser:go-back-tab', tab.id) : undefined}
              onGoForward={isWeb ? () => void window.marudesk.invoke('browser:go-forward-tab', tab.id) : undefined}
              onReload={isWeb ? () => void window.marudesk.invoke('browser:reload-tab', { tabId: tab.id }) : undefined}
              onOpenDevtools={isWeb ? () => openDevtoolsFor(tab.id) : undefined}
              onStartConnect={(side, cx, cy) => startConnect(tab.id, side, cx, cy)}
            />
          );
        })}

        {/* Delete control for the selected edge — rendered ABOVE the cards (high
            z) so it's clickable even when the edge's midpoint falls over a card
            (a side-anchored wire often does). */}
        {(() => {
          if (!selectedEdgeId) return null;
          const sel = visibleEdges.find((e) => e.id === selectedEdgeId);
          if (!sel) return null;
          const a = nodeRects[keyOf(sel.from)];
          const b = nodeRects[keyOf(sel.to)];
          if (!a || !b) return null;
          const { p1, p2, fromSide, toSide } = edgeEndpoints(a, b, sel);
          // Sit the control on the rendered path (its visual midpoint), not the
          // straight chord midpoint — a curved or right-angled wire bows away.
          const mid = edgeMidpoint(edgeStyle, p1, fromSide, p2, toSide);
          return (
            <button
              type="button"
              aria-label={t('canvas.edge.remove')}
              title={t('canvas.edge.remove')}
              style={{ left: mid.x - 11, top: mid.y - 11, zIndex: 100000 }}
              className="absolute grid h-[22px] w-[22px] place-items-center rounded-pill border border-default bg-surface-2 text-caption text-fg-secondary shadow-card transition-colors duration-fast hover:bg-surface-3 hover:text-fg-primary"
              onPointerDown={(ev) => ev.stopPropagation()}
              onClick={(ev) => {
                ev.stopPropagation();
                useCanvasStore.getState().removeEdge(sel.id);
              }}
            >
              <span aria-hidden>×</span>
            </button>
          );
        })()}

        {/* Marquee (drag-box) selection rectangle, in canvas coords. */}
        {marquee ? (
          <div
            aria-hidden
            className="pointer-events-none absolute rounded-sm border border-accent bg-accent/10"
            style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h, zIndex: 99999 }}
          />
        ) : null}

        {/* Live alignment guides (canvas coords) — drawn while a dragged card snaps
            to another's edge/center, so the snap is visible, not silent. Thickness
            is 1px on screen at any zoom (canvas-space = 1/scale). */}
        {dragGuides.map((g) => (
          <div
            key={`${g.axis}:${g.at}:${g.from}`}
            aria-hidden
            className="pointer-events-none absolute bg-accent"
            style={
              g.axis === 'x'
                ? {
                    left: g.at - 0.5 / viewport.scale,
                    top: g.from,
                    width: 1 / viewport.scale,
                    height: g.to - g.from,
                    zIndex: 99998,
                  }
                : {
                    left: g.from,
                    top: g.at - 0.5 / viewport.scale,
                    width: g.to - g.from,
                    height: 1 / viewport.scale,
                    zIndex: 99998,
                  }
            }
          />
        ))}
      </div>

      {/* Minimap (cate parity — ⌘/Ctrl+Shift+M). */}
      {minimapOpen ? (
        <CanvasMinimap
          placements={placements}
          sections={sections}
          notes={notes}
          viewport={viewport}
          width={size.w}
          height={size.h}
          onJump={centerOn}
        />
      ) : null}

      {/* AI process flow — the focused chat's plan as a steerable node graph,
          distinct from the spatial tool cards (it self-hides with no plan). */}
      {planFlowOpen ? (
        <CanvasPlanFlow
          workspaceId={activeWorkspaceId ?? undefined}
          onClose={() => setPlanFlowOpen(false)}
        />
      ) : null}

      {/* Top-left toolbar: workspace switcher (only with >1 workspace, since the
          canvas has no workspace rail) + the New-card affordance. */}
      <div className="absolute left-3 top-3 z-50 flex items-center gap-2">
        {workspaces.length > 1 ? (
          <button
            type="button"
            title={t('canvas.toolbar.switchWorkspace')}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setWsMenu({ x: r.left, y: r.bottom + 4 });
            }}
            className="inline-flex items-center gap-1.5 rounded-lg chrome-panel px-2.5 py-1.5 text-caption text-fg-secondary shadow-card transition-colors duration-fast hover:text-fg-primary active:translate-y-px"
          >
            <span className="max-w-[10rem] truncate">{activeWsName ?? t('canvas.toolbar.workspaceFallback')}</span>
            <ChevronDown size={13} />
          </button>
        ) : null}
        {/* Canvas switcher — each canvas is a named saved layout. */}
        <button
          type="button"
          title={t('canvas.toolbar.switchCanvasTitle')}
          aria-label={t('canvas.toolbar.switchCanvas')}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setCanvasMenu({ x: r.left, y: r.bottom + 4 });
          }}
          className="inline-flex items-center gap-1.5 rounded-lg chrome-panel px-2.5 py-1.5 text-caption text-fg-secondary shadow-card transition-colors duration-fast hover:text-fg-primary active:translate-y-px"
        >
          <Layers size={13} />
          <span className="max-w-[10rem] truncate">{activeCanvasName}</span>
          <ChevronDown size={13} />
        </button>
        <button
          type="button"
          title={t('canvas.toolbar.newCard')}
          onClick={() => newCard('home')}
          className="inline-flex items-center gap-1.5 rounded-lg chrome-panel px-2.5 py-1.5 text-caption text-fg-secondary shadow-card transition-colors duration-fast hover:text-fg-primary active:translate-y-px"
        >
          <Plus size={14} />
          {t('canvas.toolbar.newCard')}
        </button>
      </div>

      {/* Viewport controls (bottom-right). */}
      <div className="absolute bottom-4 right-4 z-50 flex items-center gap-0.5 rounded-lg chrome-panel px-1.5 py-1 shadow-card">
        <CtrlButton label={t('canvas.control.zoomOut')} onClick={() => zoomFromCenter(1 / 1.2)}>
          <Minus size={15} />
        </CtrlButton>
        <button
          type="button"
          className="min-w-[3.25rem] px-1 text-center text-caption tabular-nums text-fg-secondary hover:text-fg-primary"
          onClick={() => {
            commitLive();
            animateReset();
          }}
          title={t('canvas.control.resetZoom')}
        >
          {Math.round(viewport.scale * 100)}%
        </button>
        <CtrlButton label={t('canvas.control.zoomIn')} onClick={() => zoomFromCenter(1.2)}>
          <Plus size={15} />
        </CtrlButton>
        <div className="mx-0.5 h-5 w-px bg-subtle" />
        <CtrlButton
          label={t('canvas.control.fit')}
          onClick={() => {
            commitLive();
            fit();
          }}
        >
          <Maximize2 size={15} />
        </CtrlButton>
        <CtrlButton
          label={t('canvas.control.resetView')}
          onClick={() => {
            commitLive();
            animateReset();
          }}
        >
          <RotateCcw size={15} />
        </CtrlButton>
        <CtrlButton
          label={t('canvas.control.arrange')}
          onClick={() => useCanvasStore.getState().arrangeCards()}
        >
          <LayoutGrid size={15} />
        </CtrlButton>
        <CtrlButton
          label={minimapOpen ? t('canvas.minimapHide') : t('canvas.minimapShow')}
          onClick={() => setMinimapOpen((v) => !v)}
        >
          <MapIcon size={15} />
        </CtrlButton>
        <CtrlButton
          label={planFlowOpen ? t('agent.flow.hide') : t('agent.flow.show')}
          onClick={() => setPlanFlowOpen((v) => !v)}
        >
          <ListTree size={15} />
        </CtrlButton>
      </div>

      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu)} onClose={() => setMenu(null)} />
      ) : null}

      {wsMenu ? (
        <ContextMenu
          x={wsMenu.x}
          y={wsMenu.y}
          onClose={() => setWsMenu(null)}
          items={workspaces.map((w) => ({
            label: w.name || t('canvas.menu.untitledWorkspace'),
            disabled: w.id === activeWorkspaceId,
            onSelect: () => void useWorkspaceDeckStore.getState().setActiveWorkspace(w.id),
          }))}
        />
      ) : null}

      {canvasMenu ? (
        <ContextMenu
          x={canvasMenu.x}
          y={canvasMenu.y}
          onClose={() => setCanvasMenu(null)}
          items={canvasMenuItems()}
        />
      ) : null}

      {shortcutsOpen ? <CanvasShortcuts onClose={() => setShortcutsOpen(false)} /> : null}

      {nameDialog ? (
        <NameDialog
          title={nameDialog.mode === 'new' ? t('canvas.dialog.newCanvas') : t('canvas.dialog.renameCanvas')}
          confirmLabel={nameDialog.mode === 'new' ? t('canvas.dialog.create') : t('canvas.dialog.rename')}
          placeholder={t('canvas.dialog.canvasNamePlaceholder')}
          initialValue={nameDialog.mode === 'rename' ? nameDialog.initial : ''}
          allowEmpty={nameDialog.mode === 'new'}
          onSubmit={(value) => {
            if (nameDialog.mode === 'new') useCanvasStore.getState().newCanvas(value);
            else useCanvasStore.getState().renameCanvas(nameDialog.id, value);
          }}
          onClose={() => setNameDialog(null)}
        />
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
      className="grid h-7 w-7 place-items-center rounded text-fg-secondary transition-colors duration-fast hover:bg-surface-3 hover:text-fg-primary active:translate-y-px"
    >
      {children}
    </button>
  );
}
