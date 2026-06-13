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
import { ChevronDown, Globe, ListTree, Map as MapIcon, Maximize2, Minus, Plus, RotateCcw } from 'lucide-react';
import { cn } from '../../lib/cn';
import { ContextMenu, type MenuItem } from '../../components/ContextMenu';
import type { TabKind, TabState } from '../../../shared/browser';
import { useTabsStore } from '../tabs/store';
import { tabKinds } from '../tabs/registry';
import { useWorkspaceDeckStore } from '../workspaces/store';
import { CanvasCard, type CardGroupProps } from './CanvasCard';
import { CanvasEdges, type ConnectPreview } from './CanvasEdges';
import { CanvasMinimap } from './CanvasMinimap';
import { CanvasPlanFlow } from './CanvasPlanFlow';
import { edgeEndpoints, nearestSide } from './edgeGeometry';
import { placementKey, useCanvasStore, type CardRect, type EdgeSide } from './store';
import { FILE_DND_MIME, openFileDragAsTab, parseFileDrag } from '../workspace/fileDrag';

type CanvasMenu =
  | { x: number; y: number; kind: 'canvas' }
  | { x: number; y: number; kind: 'card'; tabId: string }
  | { x: number; y: number; kind: 'edge'; edgeId: string };

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
  const tabs = useTabsStore((s) => s.tabs);
  const activateTab = useTabsStore((s) => s.activateTab);
  const placements = useCanvasStore((s) => s.placements);
  const edges = useCanvasStore((s) => s.edges);
  const edgeStyle = useCanvasStore((s) => s.edgeStyle);
  const groups = useCanvasStore((s) => s.groups);
  const selection = useCanvasStore((s) => s.selection);
  const selectedEdgeId = useCanvasStore((s) => s.selectedEdgeId);
  const viewport = useCanvasStore((s) => s.viewport);
  const focusedTabId = useCanvasStore((s) => s.focusedTabId);
  const activeWorkspaceId = useWorkspaceDeckStore((s) => s.activeWorkspaceId);
  const workspaces = useWorkspaceDeckStore((s) => s.workspaces);

  // Scope cards to the active workspace so multiple workspaces don't pile onto
  // one canvas; fall back to all tabs when no workspace is active. Placements are
  // keyed by (unique) tab id (or a group id), so the shared store needs no
  // per-workspace split.
  const visibleTabs = activeWorkspaceId
    ? tabs.filter((t) => t.workspaceId === activeWorkspaceId)
    : tabs;
  const visibleIds = new Set(visibleTabs.map((t) => t.id));
  // Map a tab to its placement key (group id when merged) for edge anchoring.
  const keyOf = (tabId: string): string => placementKey(groups, tabId);
  // Only draw edges whose both endpoints are visible; skip intra-group edges
  // (both ends resolve to the same card).
  const visibleEdges = edges.filter(
    (e) => visibleIds.has(e.from) && visibleIds.has(e.to) && keyOf(e.from) !== keyOf(e.to),
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
  // Marquee (drag-box) selection rect in canvas coords while dragging, or null.
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  // True while Space is held → empty-canvas left-drag pans instead of marqueeing.
  const [spacePan, setSpacePan] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
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

  // Keep placements in step with the open tabs (initial mount + later changes).
  useEffect(() => {
    useCanvasStore.getState().syncPlacements(tabIdsKey ? tabIdsKey.split('\n') : []);
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
      const store = useCanvasStore.getState();
      if (e.ctrlKey || e.metaKey) {
        // Zoom at the cursor (also catches trackpad pinch, which arrives as ctrl+wheel).
        const r = el.getBoundingClientRect();
        store.zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
      } else if (e.shiftKey) {
        // Shift + wheel = horizontal pan (Figma).
        store.panBy(-(e.deltaY || e.deltaX), 0);
      } else {
        // Plain wheel / trackpad = two-axis pan.
        store.panBy(-e.deltaX, -e.deltaY);
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // Never start on a card or an on-canvas control — capturing here would
    // swallow their clicks.
    if ((e.target as HTMLElement).closest('[data-canvas-card], button, [data-edge-id]')) return;
    // Pan with the middle button or Space+left (Figma); plain left marquee-selects
    // empty canvas; right opens the context menu.
    const pan = e.button === 1 || (e.button === 0 && spaceDownRef.current);
    if (pan) {
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
      useCanvasStore.getState().panBy(dx, dy);
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
      if (maxX - minX < 4 && maxY - minY < 4) return; // a click, not a drag
      const store = useCanvasStore.getState();
      const grouped = new Set(groups.flatMap((g) => g.tabIds));
      const sel: string[] = [];
      for (const [key, r] of Object.entries(store.placements)) {
        const grp = groups.find((g) => g.id === key);
        const rendered = grp
          ? grp.tabIds.some((id) => visibleIds.has(id))
          : visibleIds.has(key) && !grouped.has(key);
        if (!rendered) continue;
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
  const snapMove = (tabId: string, x: number, y: number) => {
    const store = useCanvasStore.getState();
    const pl = store.placements;
    const cur = pl[tabId];
    if (!cur) {
      return;
    }
    const { w, h } = cur;
    // Constant in screen px (so the feel is the same at any zoom).
    const SNAP = 6 / store.viewport.scale;
    // Read the visible set fresh (a mid-drag workspace switch shouldn't snap to
    // the previous workspace's cards).
    const aws = useWorkspaceDeckStore.getState().activeWorkspaceId;
    const tabsNow = useTabsStore.getState().tabs;
    const vis = aws ? tabsNow.filter((t) => t.workspaceId === aws) : tabsNow;
    let sx = x;
    let sy = y;
    let dx = SNAP;
    let dy = SNAP;
    for (const t of vis) {
      if (t.id === tabId) continue;
      const r = pl[t.id];
      if (!r) continue;
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
    useCanvasStore.getState().setPos(tabId, sx, sy);
  };

  // Header drag: if the dragged card is part of a multi-selection, move the whole
  // selection together (per-frame delta, no snap); otherwise snap the single card.
  const handleMove = (key: string, x: number, y: number) => {
    const store = useCanvasStore.getState();
    const sel = store.selection;
    if (sel.length > 1 && sel.includes(key)) {
      const pl = store.placements;
      const cur = pl[key];
      if (!cur) return;
      const dx = x - cur.x;
      const dy = y - cur.y;
      for (const k of sel) {
        const r = pl[k];
        if (!r || r.locked) continue;
        if (k === key) store.setPos(k, x, y);
        else store.setPos(k, r.x + dx, r.y + dy);
      }
    } else {
      snapMove(key, x, y);
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
    const aws = useWorkspaceDeckStore.getState().activeWorkspaceId;
    const tabsNow = useTabsStore.getState().tabs;
    const vis = new Set((aws ? tabsNow.filter((t) => t.workspaceId === aws) : tabsNow).map((t) => t.id));
    const grouped = new Set(cs.groups.flatMap((g) => g.tabIds));
    const keys: string[] = [];
    for (const key of Object.keys(cs.placements)) {
      const grp = cs.groups.find((g) => g.id === key);
      const rendered = grp ? grp.tabIds.some((id) => vis.has(id)) : vis.has(key) && !grouped.has(key);
      if (rendered) keys.push(key);
    }
    return keys;
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

  // Drag a connection from a card's port to another card. Window listeners (the
  // drag crosses the whole canvas); the drop target is hit-tested by [data-tab-id].
  const startConnect = useCallback(
    (fromTabId: string, fromSide: EdgeSide, clientX: number, clientY: number) => {
      const p = toCanvas(clientX, clientY);
      setConnect({ from: fromTabId, fromSide, x: p.x, y: p.y });
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
        const { placements: pl, groups: gs } = useCanvasStore.getState();
        const fromKey = placementKey(gs, fromTabId);
        const aws = useWorkspaceDeckStore.getState().activeWorkspaceId;
        const visSet = new Set(
          (aws ? useTabsStore.getState().tabs.filter((t) => t.workspaceId === aws) : useTabsStore.getState().tabs).map(
            (t) => t.id,
          ),
        );
        let targetKey: string | null = null;
        let targetRect: CardRect | null = null;
        let bestZ = -Infinity;
        for (const [key, r] of Object.entries(pl)) {
          if (key === fromKey) continue;
          const grp = gs.find((g) => g.id === key);
          const visible = grp ? grp.tabIds.some((id) => visSet.has(id)) : visSet.has(key);
          if (!visible) continue;
          if (pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h && r.z > bestZ) {
            bestZ = r.z;
            targetKey = key;
            targetRect = r;
          }
        }
        // Pin the target end to the face nearest the drop point (4-directional);
        // a group target connects to its active member (edges are tab-keyed).
        if (targetKey && targetRect) {
          const grp = gs.find((g) => g.id === targetKey);
          const targetTabId = grp ? grp.activeId : targetKey;
          useCanvasStore.getState().addEdge(fromTabId, targetTabId, fromSide, nearestSide(targetRect, pt));
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
      .map((id) => tabs.find((t) => t.id === id))
      .filter((t): t is TabState => !!t)
      .map((t) => ({
        id: t.id,
        title: t.title?.trim() || tabKinds[t.kind]?.title || 'Tab',
        icon: tabKinds[t.kind]?.icon ?? Globe,
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

  const newCard = useCallback(
    (kind: TabKind = 'home', at?: { x: number; y: number }) => {
      void (async () => {
        await useTabsStore.getState().newTab(kind, undefined, activeWorkspaceId ?? undefined);
        const id = useTabsStore.getState().activeTabId;
        if (!id) return;
        const store = useCanvasStore.getState();
        const rect = store.placements[id];
        if (!rect) return;
        // Place the card centered on the cursor / drop point when given one
        // (right-click + double-click), instead of the default grid slot.
        if (at) store.setPos(id, Math.round(at.x - rect.w / 2), Math.round(at.y - rect.h / 2));
        // Focus the new card (it became the active tab) so it's the live surface
        // immediately — matters for agent cards, which only run live when focused.
        store.setFocused(id);
        store.bringToFront(id);
      })();
    },
    [activeWorkspaceId],
  );

  // Right-click: a context menu for the edge / card-header / empty canvas under
  // the cursor. Right-clicking a card BODY is left to the surface (Monaco, xterm,
  // a web page) so its own menu still works — only the card header opens the card
  // menu.
  const onContextMenu = (e: ReactMouseEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    const edgeEl = t.closest('[data-edge-id]');
    if (edgeEl) {
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY, kind: 'edge', edgeId: edgeEl.getAttribute('data-edge-id') ?? '' });
      return;
    }
    const headerEl = t.closest('[data-card-header]');
    if (headerEl) {
      const id = headerEl.closest('[data-tab-id]')?.getAttribute('data-tab-id');
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
    if ((e.target as HTMLElement).closest('[data-canvas-card], button, [data-edge-id]')) return;
    newCard('home', toCanvas(e.clientX, e.clientY));
  };

  const menuItems = (m: CanvasMenu): MenuItem[] => {
    const store = useCanvasStore.getState();
    if (m.kind === 'edge') {
      return [
        {
          label: edgeStyle === 'curve' ? 'Square connections' : 'Curved connections',
          onSelect: () => store.toggleEdgeStyle(),
        },
        { type: 'separator' },
        { label: 'Remove connection', danger: true, onSelect: () => store.removeEdge(m.edgeId) },
      ];
    }
    if (m.kind === 'card') {
      const tab = tabs.find((t) => t.id === m.tabId);
      // For a grouped card the placement key is the group id; raise/lower that.
      const placeKey = keyOf(m.tabId);
      const inGroup = placeKey !== m.tabId;
      const rect = placements[placeKey];
      const items: MenuItem[] = [
        { label: 'Bring to front', onSelect: () => store.bringToFront(placeKey) },
        { label: 'Send to back', onSelect: () => store.sendToBack(placeKey) },
        {
          label: rect?.preMax ? 'Restore size' : 'Maximize',
          onSelect: () => store.toggleMaximize(placeKey, maximizeRect()),
        },
        { label: rect?.locked ? 'Unlock' : 'Lock', onSelect: () => store.toggleLock(placeKey) },
      ];
      if (inGroup) {
        items.push({ label: 'Pop out tab', onSelect: () => store.popOutTab(m.tabId) });
      }
      if (tab?.kind === 'web') {
        items.push(
          { type: 'separator' },
          {
            label: 'Reload',
            onSelect: () =>
              void (async () => {
                await useTabsStore.getState().activateTab(m.tabId);
                await window.marudesk.invoke('browser:reload');
              })(),
          },
          {
            label: 'Open DevTools',
            onSelect: () => void window.marudesk.invoke('devtools:popout-open', { tabId: m.tabId }),
          },
          {
            label: 'Copy link',
            disabled: !tab.url,
            onSelect: () => void window.marudesk.invoke('clipboard:write-text', tab.url),
          },
        );
      }
      items.push(
        { type: 'separator' },
        { label: 'Close card', danger: true, onSelect: () => void useTabsStore.getState().closeTab(m.tabId) },
      );
      return items;
    }
    return [
      { label: 'New browser tab', onSelect: () => newCard('web', toCanvas(m.x, m.y)) },
      { label: 'New terminal', onSelect: () => newCard('terminal', toCanvas(m.x, m.y)) },
      { label: 'New editor', onSelect: () => newCard('editor', toCanvas(m.x, m.y)) },
      { label: 'New AI chat', onSelect: () => newCard('agent', toCanvas(m.x, m.y)) },
      { type: 'separator' },
      { label: 'Fit to content', onSelect: () => fit() },
      { label: 'Reset zoom', onSelect: () => store.resetView() },
      { type: 'separator' },
      {
        label: edgeStyle === 'curve' ? 'Square connections' : 'Curved connections',
        onSelect: () => store.toggleEdgeStyle(),
      },
      { label: minimapOpen ? 'Hide minimap' : 'Show minimap', onSelect: () => setMinimapOpen((v) => !v) },
      { label: planFlowOpen ? 'Hide process' : 'Show process', onSelect: () => setPlanFlowOpen((v) => !v) },
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
      if (e.key === 'Escape') {
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
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
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
        'relative h-full w-full overflow-hidden bg-surface-page',
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
          const store = useCanvasStore.getState();
          const rect = id ? store.placements[id] : undefined;
          if (id && rect) {
            store.setPos(id, Math.round(pt.x - rect.w / 2), Math.round(pt.y - rect.h / 2));
            store.setFocused(id);
            store.bringToFront(id);
          }
        })();
      }}
      aria-label="Canvas"
      tabIndex={-1}
    >
      <div
        className="absolute inset-0 origin-top-left"
        style={{
          transform: `translate(${viewport.panX}px, ${viewport.panY}px) scale(${viewport.scale})`,
        }}
      >
        {/* Node connections, drawn behind the cards. */}
        <CanvasEdges
          placements={placements}
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
              onNudge={(x, y) => useCanvasStore.getState().setPos(key, x, y)}
              onResize={(w, h) => useCanvasStore.getState().setSize(key, w, h)}
              // Merge only by dragging an ungrouped card (its key === tab id);
              // dragging a group just moves it.
              onHeaderDragMove={group ? undefined : (cx, cy) => headerDragMove(tab.id, cx, cy)}
              onHeaderDrop={group ? undefined : (cx, cy) => headerDrop(tab.id, cx, cy)}
              registerWebEl={isWeb ? (el) => registerWebEl(tab.id, el) : undefined}
              onNavigate={
                isWeb
                  ? (input) => {
                      // Navigate targets the active tab, so activate this card's
                      // tab first, then hand the input to the browser (it
                      // normalizes URL vs. search term in the main process).
                      void (async () => {
                        await useTabsStore.getState().activateTab(tab.id);
                        await window.marudesk.invoke('browser:navigate', input);
                      })();
                    }
                  : undefined
              }
              onOpenDevtools={
                isWeb
                  ? () => void window.marudesk.invoke('devtools:popout-open', { tabId: tab.id })
                  : undefined
              }
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
          const a = placements[keyOf(sel.from)];
          const b = placements[keyOf(sel.to)];
          if (!a || !b) return null;
          const { p1, p2 } = edgeEndpoints(a, b, sel);
          return (
            <button
              type="button"
              aria-label="Remove connection"
              title="Remove connection"
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
            title="Switch workspace"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setWsMenu({ x: r.left, y: r.bottom + 4 });
            }}
            className="inline-flex items-center gap-1.5 rounded-lg chrome-panel px-2.5 py-1.5 text-caption text-fg-secondary shadow-card transition-colors duration-fast hover:text-fg-primary active:translate-y-px"
          >
            <span className="max-w-[10rem] truncate">{activeWsName ?? 'Workspace'}</span>
            <ChevronDown size={13} />
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => newCard('home')}
          className="inline-flex items-center gap-1.5 rounded-lg chrome-panel px-2.5 py-1.5 text-caption text-fg-secondary shadow-card transition-colors duration-fast hover:text-fg-primary active:translate-y-px"
        >
          <Plus size={14} />
          New card
        </button>
      </div>

      {/* Viewport controls (bottom-right). */}
      <div className="absolute bottom-4 right-4 z-50 flex items-center gap-0.5 rounded-lg chrome-panel px-1.5 py-1 shadow-card">
        <CtrlButton label="Zoom out" onClick={() => zoomFromCenter(1 / 1.2)}>
          <Minus size={15} />
        </CtrlButton>
        <button
          type="button"
          className="min-w-[3.25rem] px-1 text-center text-caption tabular-nums text-fg-secondary hover:text-fg-primary"
          onClick={() => useCanvasStore.getState().resetView()}
          title="Reset zoom to 100%"
        >
          {Math.round(viewport.scale * 100)}%
        </button>
        <CtrlButton label="Zoom in" onClick={() => zoomFromCenter(1.2)}>
          <Plus size={15} />
        </CtrlButton>
        <div className="mx-0.5 h-5 w-px bg-subtle" />
        <CtrlButton label="Fit to content" onClick={fit}>
          <Maximize2 size={15} />
        </CtrlButton>
        <CtrlButton label="Reset view" onClick={() => useCanvasStore.getState().resetView()}>
          <RotateCcw size={15} />
        </CtrlButton>
        <CtrlButton
          label={minimapOpen ? 'Hide minimap' : 'Show minimap'}
          onClick={() => setMinimapOpen((v) => !v)}
        >
          <MapIcon size={15} />
        </CtrlButton>
        <CtrlButton
          label={planFlowOpen ? 'Hide process' : 'Show process'}
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
            label: w.name || 'Untitled',
            disabled: w.id === activeWorkspaceId,
            onSelect: () => void useWorkspaceDeckStore.getState().setActiveWorkspace(w.id),
          }))}
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
