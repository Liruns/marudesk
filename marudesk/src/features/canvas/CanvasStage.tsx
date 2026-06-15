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
  FileText,
  Globe,
  Group,
  Layers,
  ListTree,
  Map as MapIcon,
  Maximize2,
  Minus,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  Workflow,
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
import { CanvasPlanFlow } from './CanvasPlanFlow';
import { WorkGraphNodes, WorkGraphPanel } from '../work-graph/WorkGraphLayer';
import { useWorkGraphStore } from '../work-graph/store';
import { edgeEndpoints, nearestSide } from './edgeGeometry';
import { cardDefaultSize, placementKey, useCanvasStore, type CardGroup, type CardRect, type EdgeSide } from './store';
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
 * How many files a drag carries. A native OS drop exposes its file items (kind
 * 'file') during dragover even though their data is only readable on drop; our
 * own explorer drag carries a single serialized file ref under {@link
 * FILE_DND_MIME}. Returns 0 when the drag isn't a file drag at all.
 */
function dragFileCount(dt: DataTransfer): number {
  if (dt.types.includes(FILE_DND_MIME)) return 1;
  if (!dt.types.includes('Files')) return 0;
  let n = 0;
  for (const item of dt.items) if (item.kind === 'file') n += 1;
  return n || 1;
}

/**
 * Cascade `count` card rects out from a drop point (canvas coords), each `size`,
 * staggered so a multi-file drop fans out into a readable stack instead of
 * landing exactly on top of itself. The first card is centered on the point.
 */
function fileDropRects(
  cx: number,
  cy: number,
  count: number,
  size: { w: number; h: number },
): { x: number; y: number; w: number; h: number }[] {
  const step = 32;
  const rects: { x: number; y: number; w: number; h: number }[] = [];
  for (let i = 0; i < count; i += 1) {
    rects.push({
      x: Math.round(cx - size.w / 2 + i * step),
      y: Math.round(cy - size.h / 2 + i * step),
      w: size.w,
      h: size.h,
    });
  }
  return rects;
}

/**
 * Should the wheel scroll a panel's own content instead of panning the canvas?
 * Walk up from the wheel target to the canvas container looking for a scrollable
 * surface inside a card. Editors and terminals scroll via their own machinery
 * (overflow:hidden + transforms), so trust their root; generic overflow boxes
 * (lists, chat transcript, settings, devtools) claim the wheel only while they
 * still have room in that direction, so a fully-scrolled panel chains back to a
 * canvas pan (FigJam-style scroll chaining).
 */
function wheelOverScrollable(
  target: EventTarget | null,
  stop: HTMLElement,
  deltaX: number,
  deltaY: number,
): boolean {
  if (target instanceof HTMLElement && target.closest('.monaco-editor, .xterm')) return true;
  let node = target instanceof HTMLElement ? target : null;
  while (node && node !== stop) {
    const style = getComputedStyle(node);
    const scrollsY =
      (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
      node.scrollHeight > node.clientHeight + 1;
    const scrollsX =
      (style.overflowX === 'auto' || style.overflowX === 'scroll') &&
      node.scrollWidth > node.clientWidth + 1;
    if (deltaY !== 0 && scrollsY) {
      const atTop = node.scrollTop <= 0;
      const atBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
      if (!((deltaY < 0 && atTop) || (deltaY > 0 && atBottom))) return true;
    }
    if (deltaX !== 0 && scrollsX) {
      const atLeft = node.scrollLeft <= 0;
      const atRight = node.scrollLeft + node.clientWidth >= node.scrollWidth - 1;
      if (!((deltaX < 0 && atLeft) || (deltaX > 0 && atRight))) return true;
    }
    node = node.parentElement;
  }
  return false;
}

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
export function CanvasStage() {
  const { t, formatCanvasGroupSection } = useI18n();
  const tabs = useTabsStore((s) => s.tabs);
  const activateTab = useTabsStore((s) => s.activateTab);
  const placements = useCanvasStore((s) => s.placements);
  const edges = useCanvasStore((s) => s.edges);
  const edgeStyle = useCanvasStore((s) => s.edgeStyle);
  const groups = useCanvasStore((s) => s.groups);
  const sections = useCanvasStore((s) => s.sections);
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
  // Ghost rects (canvas coords) showing where dragged-in files will land as
  // cards — set while files hover the canvas, cleared on drop / leave.
  const [dropPreview, setDropPreview] = useState<
    { x: number; y: number; w: number; h: number }[] | null
  >(null);
  // Container size (px) for the minimap's viewport overlay, and minimap toggle.
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [minimapOpen, setMinimapOpen] = useState(true);
  // The AI process-flow overlay (the focused chat's plan as a node graph).
  const [planFlowOpen, setPlanFlowOpen] = useState(true);
  // The AI Work-OS task-graph controls panel (Task nodes draw on the canvas).
  const [tasksOpen, setTasksOpen] = useState(false);
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
  // True while Space is held → empty-canvas left-drag pans instead of marqueeing.
  const [spacePan, setSpacePan] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  // The CSS-transformed plane (cards live inside it). Panning writes its transform
  // directly so a drag never re-renders React — the perf fix for "휠 클릭 버벅거림".
  const planeRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  // Live (uncommitted) pan offset while a pan gesture is in flight, or null when
  // the store is authoritative. The plane/grid transform is driven straight from
  // this on each pointer/wheel event, and only committed to the store on gesture
  // end — so cards/edges aren't re-rendered ~120×/sec mid-pan.
  const livePanRef = useRef<{ panX: number; panY: number } | null>(null);
  // Trailing-commit timer for wheel panning (no pointerup to commit on).
  const wheelCommitRef = useRef<number | null>(null);
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
      // Send the canvas zoom so main scales each web view's page to match.
      const scale = useCanvasStore.getState().viewport.scale;
      const key = JSON.stringify({ panes, scale });
      if (key === lastSentRef.current) return; // nothing changed → skip the IPC
      lastSentRef.current = key;
      void window.marudesk.invoke('browser:set-pane-bounds', { panes, scale });
    });
  }, []);

  // Write the live pan straight to the DOM (plane transform + grid background) so
  // a pan gesture moves at the compositor's pace without a React re-render. The
  // store stays untouched until the gesture commits.
  const applyLiveTransform = useCallback(() => {
    const lp = livePanRef.current;
    if (!lp) return;
    const scale = useCanvasStore.getState().viewport.scale;
    if (planeRef.current) {
      planeRef.current.style.transform = `translate(${lp.panX}px, ${lp.panY}px) scale(${scale})`;
    }
    if (containerRef.current) {
      containerRef.current.style.backgroundPosition = `${lp.panX}px ${lp.panY}px`;
    }
  }, []);

  // Accumulate a pan delta onto the live offset (seeding from the store on the
  // first move of a gesture), repaint the plane directly, and let the native web
  // views follow (measureWeb is itself rAF-coalesced).
  const livePanBy = useCallback(
    (dx: number, dy: number) => {
      if (!livePanRef.current) {
        const vp = useCanvasStore.getState().viewport;
        livePanRef.current = { panX: vp.panX, panY: vp.panY };
      }
      livePanRef.current.panX += dx;
      livePanRef.current.panY += dy;
      applyLiveTransform();
      measureWeb();
    },
    [applyLiveTransform, measureWeb],
  );

  // Fold the live pan back into the store (one update → one re-render) and drop
  // the live offset so React owns the transform again.
  const commitLivePan = useCallback(() => {
    if (wheelCommitRef.current !== null) {
      clearTimeout(wheelCommitRef.current);
      wheelCommitRef.current = null;
    }
    const lp = livePanRef.current;
    if (!lp) return;
    livePanRef.current = null;
    useCanvasStore.getState().setPan(lp.panX, lp.panY);
  }, []);

  // Wheel panning has no pointerup, so commit on a short trailing idle.
  const scheduleWheelCommit = useCallback(() => {
    if (wheelCommitRef.current !== null) clearTimeout(wheelCommitRef.current);
    wheelCommitRef.current = window.setTimeout(() => {
      wheelCommitRef.current = null;
      commitLivePan();
    }, 140);
  }, [commitLivePan]);

  // The store is intentionally stale during a pan, so if React happens to
  // re-render mid-gesture (a tab title update, a card animation, …) it paints the
  // plane at the committed offset. Re-assert the live transform after every render
  // (pre-paint) so the pan never snaps back for a frame.
  useLayoutEffect(() => {
    if (livePanRef.current) applyLiveTransform();
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
      if (e.ctrlKey || e.metaKey) {
        // Zoom at the cursor (also catches trackpad pinch, which arrives as
        // ctrl+wheel). Fold any in-flight wheel pan in first so the zoom anchors
        // off the real (committed) viewport, not a stale store value.
        e.preventDefault();
        commitLivePan();
        const r = el.getBoundingClientRect();
        useCanvasStore
          .getState()
          .zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
        return;
      }
      // A scrollable panel under the pointer (editor, terminal, list, chat) owns
      // the wheel — let it scroll its own content natively rather than panning
      // the canvas out from under it.
      if (wheelOverScrollable(e.target, el, e.deltaX, e.deltaY)) return;
      e.preventDefault();
      if (e.shiftKey) {
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
  }, [livePanBy, commitLivePan, scheduleWheelCommit]);

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
      useCanvasStore.getState().zoomAt(Math.exp(-deltaY * 0.0015), cx, cy);
    });
  }, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // Never start on a card or an on-canvas control — capturing here would
    // swallow their clicks.
    if ((e.target as HTMLElement).closest('[data-canvas-card], [data-canvas-section], button, [data-edge-id]')) return;
    // Pan with the middle button or Space+left (Figma); plain left marquee-selects
    // empty canvas; right opens the context menu.
    const pan = e.button === 1 || (e.button === 0 && spaceDownRef.current);
    if (pan) {
      // Fold any trailing wheel pan in before a drag starts from a clean offset.
      commitLivePan();
      e.currentTarget.setPointerCapture(e.pointerId);
      panRef.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
      setPanning(true);
      return;
    }
    if (e.button !== 0) return;
    const store = useCanvasStore.getState();
    store.setFocused(null);
    store.selectEdge(null);
    store.clearSelection();
    useWorkGraphStore.getState().selectTask(null);
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
      // Commit the gesture's accumulated offset to the store in one update.
      commitLivePan();
      setPanning(false);
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
  const computeSnap = (tabId: string, x: number, y: number): { x: number; y: number } => {
    const store = useCanvasStore.getState();
    const pl = store.placements;
    const cur = pl[tabId];
    if (!cur) return { x, y };
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
    // Snap against every rendered card — ungrouped tabs AND merged group cards
    // (keyed by group id), so a card can align to a group, not just plain cards.
    for (const [k, r] of Object.entries(pl)) {
      if (k === tabId) continue;
      if (!isRendered(k)) continue;
      for (const cx of [r.x, r.x + r.w - w, r.x + (r.w - w) / 2, r.x + r.w, r.x - w]) {
        const d = Math.abs(x - cx);
        if (d < dx) {
          dx = d;
          sx = cx;
        }
      }
      for (const cy of [r.y, r.y + r.h - h, r.y + (r.h - h) / 2, r.y + r.h, r.y - h]) {
        const d = Math.abs(y - cy);
        if (d < dy) {
          dy = d;
          sy = cy;
        }
      }
    }
    return { x: sx, y: sy };
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

  const handleMove = (key: string, x: number, y: number) => {
    const store = useCanvasStore.getState();
    let d = cardDragRef.current;
    if (!d || d.key !== key) {
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
    }
    if (d.multi) {
      const origin = d.cards.find((c) => c.key === key);
      if (!origin) return;
      const dx = x - origin.ox;
      const dy = y - origin.oy;
      for (const c of d.cards) d.pos[c.key] = { x: c.ox + dx, y: c.oy + dy };
    } else {
      d.pos[key] = computeSnap(key, x, y);
    }
    paintCardDrag();
  };

  // Commit the drag to the store in ONE update on release; React then owns the
  // positions again, matching what we already painted (no snap-back).
  const commitCardMove = () => {
    const d = cardDragRef.current;
    if (!d) return;
    cardDragRef.current = null;
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

  // Re-assert an in-flight card drag after any incidental re-render (e.g. the
  // merge-highlight setState) so the dragged card never snaps to its stale store
  // position for a frame. Declared after the helpers so the rule sees the ref.
  useLayoutEffect(() => {
    if (cardDragRef.current) paintCardDrag();
  });

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
  const zoomFromCenter = (factor: number) => {
    useCanvasStore.getState().zoomAt(factor, size.w / 2, size.h / 2);
  };
  const fit = () => {
    useCanvasStore.getState().fitToContent(size.w, size.h);
  };
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

  // Screen px → canvas coords (inverse of the plane's translate+scale).
  const toCanvas = useCallback((clientX: number, clientY: number) => {
    const el = containerRef.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    const { panX, panY, scale } = useCanvasStore.getState().viewport;
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

  // A spot for a NEW card with no explicit drop point (the toolbar button): the
  // first free grid cell inside the visible viewport, so it always lands on-screen
  // (not at the off-screen canvas origin when panned away) AND doesn't stack on an
  // existing card. Pending spawns are counted too, so rapid clicks don't collide.
  const placeInView = useCallback(
    (kind: TabKind): { x: number; y: number; w: number; h: number } => {
      const cs = useCanvasStore.getState();
      const { panX, panY, scale } = cs.viewport;
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
    if ((e.target as HTMLElement).closest('[data-canvas-card], [data-canvas-section], button, [data-edge-id]')) return;
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
            { type: 'separator' as const },
          ]
        : []),
      { label: t('canvas.menu.newBrowserTab'), onSelect: () => newCard('web', toCanvas(m.x, m.y)) },
      { label: t('canvas.menu.newTerminal'), onSelect: () => newCard('terminal', toCanvas(m.x, m.y)) },
      { label: t('canvas.menu.newEditor'), onSelect: () => newCard('editor', toCanvas(m.x, m.y)) },
      { label: t('canvas.menu.newAiChat'), onSelect: () => newCard('agent', toCanvas(m.x, m.y)) },
      { type: 'separator' },
      { label: t('canvas.control.fit'), onSelect: () => fit() },
      { label: t('canvas.menu.resetZoom'), onSelect: () => store.resetView() },
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
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        setMinimapOpen((v) => !v);
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
  }, []);

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
        const count = dragFileCount(e.dataTransfer);
        if (count === 0) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        // Preview where (and at what size) the cards will land, tracking the
        // cursor so the drop is predictable before release.
        const pt = toCanvas(e.clientX, e.clientY);
        setDropPreview(fileDropRects(pt.x, pt.y, count, cardDefaultSize('editor')));
      }}
      onDragLeave={(e) => {
        // dragleave also fires when crossing into a child — only clear when the
        // pointer truly leaves the canvas surface.
        const next = e.relatedTarget;
        if (next instanceof Node && e.currentTarget.contains(next)) return;
        setDropPreview(null);
      }}
      onDrop={(e) => {
        if (dragFileCount(e.dataTransfer) === 0) return;
        e.preventDefault();
        setDropPreview(null);
        const pt = toCanvas(e.clientX, e.clientY);
        const size = cardDefaultSize('editor');
        // Our own explorer drag: a single serialized file ref.
        if (e.dataTransfer.types.includes(FILE_DND_MIME)) {
          const payload = parseFileDrag(e.dataTransfer.getData(FILE_DND_MIME));
          if (!payload) return;
          const [rect] = fileDropRects(pt.x, pt.y, 1, size);
          void (async () => {
            const id = await openFileDragAsTab(payload);
            if (!id) return;
            useCanvasStore.getState().placeNext(id, rect);
            raiseWhenPlaced(id);
          })();
          return;
        }
        // Native OS file drop (one or many files, any extension): open each as an
        // editor card, fanned out from the cursor. Resolve every path up front
        // (synchronously, before any await) since the File list is neutered once
        // the drop event returns.
        const paths = Array.from(e.dataTransfer.files)
          .map((file) => window.marudesk.getPathForFile(file))
          .filter((p): p is string => !!p);
        if (paths.length === 0) return;
        const rects = fileDropRects(pt.x, pt.y, paths.length, size);
        void (async () => {
          for (let i = 0; i < paths.length; i += 1) {
            const id = await openFileDragAsTab({ path: paths[i] });
            if (!id) continue;
            useCanvasStore.getState().placeNext(id, rects[i]);
            raiseWhenPlaced(id);
          }
        })();
      }}
      aria-label={t('canvas.label')}
      tabIndex={-1}
    >
      <div
        ref={planeRef}
        className="absolute inset-0 origin-top-left"
        style={{
          transform: `translate(${viewport.panX}px, ${viewport.panY}px) scale(${viewport.scale})`,
          // Promote to its own compositor layer so panning is a GPU transform,
          // not a paint — the rest of the "버벅거림" fix beyond skipping re-renders.
          willChange: 'transform',
        }}
      >
        {/* Section frames, drawn behind everything (zIndex 0). */}
        <CanvasSections
          sections={sections}
          scale={viewport.scale}
          onStartConnect={(sectionId, side, cx, cy) => startConnect(sectionId, side, cx, cy)}
        />
        {/* Ghost preview of where dragged-in files will land (above cards). */}
        {dropPreview?.map((r, i) => (
          <div
            key={i}
            className="pointer-events-none absolute rounded-lg border-2 border-dashed border-accent/70 bg-accent/10"
            style={{ left: r.x, top: r.y, width: r.w, height: r.h, zIndex: 90000 }}
          >
            <span className="m-1.5 inline-flex items-center gap-1 rounded bg-accent/15 px-1.5 py-0.5 text-caption text-accent">
              <FileText size={12} aria-hidden />
              {t('canvas.drop.preview')}
            </span>
          </div>
        ))}
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
              onMove={(x, y) => handleMove(key, x, y)}
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
          const { p1, p2 } = edgeEndpoints(a, b, sel);
          return (
            <button
              type="button"
              aria-label={t('canvas.edge.remove')}
              title={t('canvas.edge.remove')}
              style={{ left: (p1.x + p2.x) / 2 - 11, top: (p1.y + p2.y) / 2 - 11, zIndex: 100000 }}
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

        {/* AI Work-OS Task nodes (drawn on the canvas plane; positions keyed by
            Task.id, independent of tabs). Returns null with no graph. */}
        <WorkGraphNodes toCanvas={toCanvas} scale={viewport.scale} />

        {/* Marquee (drag-box) selection rectangle, in canvas coords. */}
        {marquee ? (
          <div
            aria-hidden
            className="pointer-events-none absolute rounded-sm border border-accent bg-accent/10"
            style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h, zIndex: 99999 }}
          />
        ) : null}
      </div>

      {/* Minimap (cate parity — ⌘/Ctrl+Shift+M). */}
      {minimapOpen ? (
        <CanvasMinimap
          placements={placements}
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
        <button
          type="button"
          title={t('canvas.toolbar.tasksTitle')}
          aria-label={t('canvas.toolbar.tasksToggle')}
          onClick={() => setTasksOpen((v) => !v)}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-lg chrome-panel px-2.5 py-1.5 text-caption shadow-card transition-colors duration-fast active:translate-y-px',
            tasksOpen ? 'text-accent' : 'text-fg-secondary hover:text-fg-primary',
          )}
        >
          <Workflow size={14} />
          {t('canvas.toolbar.tasks')}
        </button>
      </div>

      {tasksOpen ? <WorkGraphPanel onClose={() => setTasksOpen(false)} /> : null}

      {/* Viewport controls (bottom-right). */}
      <div className="absolute bottom-4 right-4 z-50 flex items-center gap-0.5 rounded-lg chrome-panel px-1.5 py-1 shadow-card">
        <CtrlButton label={t('canvas.control.zoomOut')} onClick={() => zoomFromCenter(1 / 1.2)}>
          <Minus size={15} />
        </CtrlButton>
        <button
          type="button"
          className="min-w-[3.25rem] px-1 text-center text-caption tabular-nums text-fg-secondary hover:text-fg-primary"
          onClick={() => useCanvasStore.getState().resetView()}
          title={t('canvas.control.resetZoom')}
        >
          {Math.round(viewport.scale * 100)}%
        </button>
        <CtrlButton label={t('canvas.control.zoomIn')} onClick={() => zoomFromCenter(1.2)}>
          <Plus size={15} />
        </CtrlButton>
        <div className="mx-0.5 h-5 w-px bg-subtle" />
        <CtrlButton label={t('canvas.control.fit')} onClick={fit}>
          <Maximize2 size={15} />
        </CtrlButton>
        <CtrlButton label={t('canvas.control.resetView')} onClick={() => useCanvasStore.getState().resetView()}>
          <RotateCcw size={15} />
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
