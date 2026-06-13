import { create } from 'zustand';
import type { TabKind } from '../../../shared/browser';
import { useTabsStore } from '../tabs/store';

/**
 * Infinite-canvas placement store (Maru identity overhaul — see
 * `docs/maru-identity-and-canvas-design.md`). Where the split grid models layout
 * as a binary tree (`features/tabs/layout.ts`), the canvas models it as **free
 * placement**: each tab/card has an absolute rect in canvas space, the whole
 * plane has a viewport (pan + zoom), and cards can be wired together with
 * **edges** (node connections — a Maru addition; cate has no inter-panel links).
 * Cards reference a `tabId`; the tab itself still owns kind/title/url/workspaceId
 * in `useTabsStore`, so this store holds only spatial state. Placements and edges
 * for closed tabs are pruned on the tab set.
 */

export type CardRect = { x: number; y: number; w: number; h: number; z: number };
export type Viewport = { panX: number; panY: number; scale: number };

/** Which face of a card an edge attaches to (4-directional ports). */
export type EdgeSide = 'top' | 'right' | 'bottom' | 'left';
/** How edges are drawn: a flowing bezier or right-angled (orthogonal) routing. */
export type EdgeStyle = 'curve' | 'orthogonal';
export const EDGE_SIDES: readonly EdgeSide[] = ['top', 'right', 'bottom', 'left'];

/**
 * A connection between two cards (by tab id). Undirected for dedup. `fromSide`/
 * `toSide` pin each end to a specific face; absent means "auto" (anchor along
 * the center ray) so edges drawn before sides existed still render.
 */
export type Edge = {
  id: string;
  from: string;
  to: string;
  fromSide?: EdgeSide;
  toSide?: EdgeSide;
};

/**
 * A stack of cards merged into one framed card with a tab strip (cate's
 * dock-in-node, clean-room). The GROUP owns the placement (keyed by `id`); its
 * member tabs have no standalone placement while grouped. Dragging a card onto
 * another merges; "pop out" splits one back to its own card.
 */
export type CardGroup = { id: string; tabIds: string[]; activeId: string };

/** Resolve the group a tab belongs to, if any. */
export function groupForTab(groups: readonly CardGroup[], tabId: string): CardGroup | undefined {
  return groups.find((g) => g.tabIds.includes(tabId));
}
/** The placement key for a tab: its group's id when grouped, else the tab id. */
export function placementKey(groups: readonly CardGroup[], tabId: string): string {
  return groupForTab(groups, tabId)?.id ?? tabId;
}

let groupSeq = 0;
function newGroupId(): string {
  groupSeq += 1;
  return `grp_${groupSeq.toString(36)}_${Math.round(performance.now()).toString(36)}`;
}

/** Generic fallback sizes; per-kind overrides live in CARD_SIZE below. */
export const CARD_DEFAULT = { w: 560, h: 380 } as const;
export const CARD_MIN = { w: 240, h: 160 } as const;

type CardSize = { w: number; h: number };

/**
 * Per-kind default + minimum card sizes. A terminal or chat needs more room than
 * a plain launcher before its chrome clips, so each surface declares its own
 * floor (cate's PANEL_DEFINITIONS.minimumSize, ported clean-room). Resize clamps
 * to `min`; fresh cards seed at `def`; unknown kinds fall back to the generic
 * pair above.
 */
const CARD_SIZE: Record<TabKind, { def: CardSize; min: CardSize }> = {
  web: { def: { w: 640, h: 460 }, min: { w: 420, h: 300 } },
  editor: { def: { w: 620, h: 440 }, min: { w: 420, h: 300 } },
  terminal: { def: { w: 600, h: 380 }, min: { w: 360, h: 240 } },
  agent: { def: { w: 600, h: 520 }, min: { w: 420, h: 360 } },
  home: { def: { w: 520, h: 380 }, min: { w: 300, h: 220 } },
  settings: { def: { w: 640, h: 520 }, min: { w: 420, h: 360 } },
  plugin: { def: { w: 520, h: 400 }, min: { w: 320, h: 240 } },
};

/** Minimum card size for a tab kind (falls back to the generic floor). */
export function cardMinSize(kind: TabKind | undefined): CardSize {
  return (kind && CARD_SIZE[kind]?.min) || CARD_MIN;
}
/** Default card size for a tab kind (falls back to the generic default). */
export function cardDefaultSize(kind: TabKind | undefined): CardSize {
  return (kind && CARD_SIZE[kind]?.def) || CARD_DEFAULT;
}

export const SCALE_MIN = 0.2;
export const SCALE_MAX = 2.5;

// Auto-placement: lay fresh cards out in a loose grid in canvas space.
const PLACE = { cols: 3, gapX: 600, gapY: 430, x0: 80, y0: 80 } as const;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isEdgeSide = (v: unknown): v is EdgeSide =>
  typeof v === 'string' && (EDGE_SIDES as readonly string[]).includes(v);
const isEdgeStyle = (v: unknown): v is EdgeStyle => v === 'curve' || v === 'orthogonal';

const edgeId = (from: string, to: string) => `${from}~${to}`;

const PERSIST_KEY = 'maru.canvas.v1';

type Persisted = {
  placements: Record<string, CardRect>;
  viewport: Viewport;
  edges: Edge[];
  edgeStyle: EdgeStyle;
  groups: CardGroup[];
  topZ: number;
};

/** Read the saved canvas layout (placements + viewport + edges). Fails closed to empty. */
function loadPersisted(): Persisted {
  const fallback: Persisted = {
    placements: {},
    viewport: { panX: 0, panY: 0, scale: 1 },
    edges: [],
    edgeStyle: 'curve',
    groups: [],
    topZ: 1,
  };
  try {
    if (typeof localStorage === 'undefined') return fallback;
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return fallback;
    const data: unknown = JSON.parse(raw);
    if (typeof data !== 'object' || data === null) return fallback;
    const rec = data as Record<string, unknown>;

    const placements: Record<string, CardRect> = {};
    if (typeof rec.placements === 'object' && rec.placements !== null) {
      for (const [id, val] of Object.entries(rec.placements as Record<string, unknown>)) {
        if (typeof val !== 'object' || val === null) continue;
        const v = val as Record<string, unknown>;
        if (isNum(v.x) && isNum(v.y) && isNum(v.w) && isNum(v.h)) {
          placements[id] = { x: v.x, y: v.y, w: v.w, h: v.h, z: isNum(v.z) ? v.z : 1 };
        }
      }
    }

    const edges: Edge[] = [];
    if (Array.isArray(rec.edges)) {
      for (const val of rec.edges) {
        if (typeof val !== 'object' || val === null) continue;
        const e = val as Record<string, unknown>;
        if (isStr(e.from) && isStr(e.to) && e.from !== e.to) {
          edges.push({
            id: isStr(e.id) ? e.id : edgeId(e.from, e.to),
            from: e.from,
            to: e.to,
            ...(isEdgeSide(e.fromSide) ? { fromSide: e.fromSide } : {}),
            ...(isEdgeSide(e.toSide) ? { toSide: e.toSide } : {}),
          });
        }
      }
    }

    const edgeStyle: EdgeStyle = isEdgeStyle(rec.edgeStyle) ? rec.edgeStyle : 'curve';

    const groups: CardGroup[] = [];
    if (Array.isArray(rec.groups)) {
      for (const val of rec.groups) {
        if (typeof val !== 'object' || val === null) continue;
        const g = val as Record<string, unknown>;
        const tabIds = Array.isArray(g.tabIds) ? g.tabIds.filter(isStr) : [];
        if (isStr(g.id) && tabIds.length >= 2 && isStr(g.activeId)) {
          groups.push({
            id: g.id,
            tabIds,
            activeId: tabIds.includes(g.activeId) ? g.activeId : tabIds[0],
          });
        }
      }
    }

    let viewport = fallback.viewport;
    if (typeof rec.viewport === 'object' && rec.viewport !== null) {
      const v = rec.viewport as Record<string, unknown>;
      if (isNum(v.panX) && isNum(v.panY) && isNum(v.scale)) {
        viewport = { panX: v.panX, panY: v.panY, scale: clamp(v.scale, SCALE_MIN, SCALE_MAX) };
      }
    }

    const zs = Object.values(placements).map((p) => p.z);
    return { placements, viewport, edges, edgeStyle, groups, topZ: zs.length ? Math.max(1, ...zs) : 1 };
  } catch {
    return fallback;
  }
}

type CanvasState = {
  /** tabId → rect+z in canvas coordinates. */
  placements: Record<string, CardRect>;
  /** Node connections between cards. */
  edges: Edge[];
  /** How all edges are drawn (curve vs orthogonal) — a canvas-wide toggle. */
  edgeStyle: EdgeStyle;
  /** Merged card stacks (tab groups). Each owns a placement keyed by its id. */
  groups: CardGroup[];
  viewport: Viewport;
  focusedTabId: string | null;
  /** The currently-selected edge (for delete), or null. */
  selectedEdgeId: string | null;
  /** Monotonic z allocator so bringToFront always wins. */
  topZ: number;
};

type CanvasActions = {
  /** Add placements for new tabs, drop placements + edges for closed ones. */
  syncPlacements: (tabIds: readonly string[]) => void;
  setPos: (tabId: string, x: number, y: number) => void;
  setSize: (tabId: string, w: number, h: number) => void;
  bringToFront: (tabId: string) => void;
  sendToBack: (tabId: string) => void;
  setFocused: (tabId: string | null) => void;
  /** Connect two cards (no-op on self / duplicate, either direction). Sides pin
      each end to a face; omit for auto (center-ray) anchoring. */
  addEdge: (from: string, to: string, fromSide?: EdgeSide, toSide?: EdgeSide) => void;
  removeEdge: (id: string) => void;
  selectEdge: (id: string | null) => void;
  /** Set / toggle how edges render (curve ⇄ orthogonal); persisted. */
  setEdgeStyle: (style: EdgeStyle) => void;
  toggleEdgeStyle: () => void;
  /** Merge `draggedTabId` into the card/group identified by `targetKey` (a tab id
      or a group id), forming/extending a tab group. The group inherits the
      target's rect; the dragged tab loses its standalone placement. */
  mergeInto: (targetKey: string, draggedTabId: string) => void;
  /** Switch which member of a group is shown. */
  setGroupActive: (groupId: string, tabId: string) => void;
  /** Split a tab back out of its group into its own card beside the group. */
  popOutTab: (tabId: string) => void;
  panBy: (dx: number, dy: number) => void;
  /** Set the absolute pan (used by the minimap to recenter). */
  setPan: (panX: number, panY: number) => void;
  /** Zoom by `factor` keeping the point (cx,cy) — container-relative px — fixed. */
  zoomAt: (factor: number, cx: number, cy: number) => void;
  resetView: () => void;
  /** Fit all cards within a container of the given size (px), with padding. */
  fitToContent: (containerW: number, containerH: number) => void;
};

function placeAt(index: number): { x: number; y: number } {
  const col = index % PLACE.cols;
  const row = Math.floor(index / PLACE.cols);
  return { x: PLACE.x0 + col * PLACE.gapX, y: PLACE.y0 + row * PLACE.gapY };
}

const persisted = loadPersisted();

export const useCanvasStore = create<CanvasState & CanvasActions>((set, get) => ({
  placements: persisted.placements,
  edges: persisted.edges,
  edgeStyle: persisted.edgeStyle,
  groups: persisted.groups,
  viewport: persisted.viewport,
  focusedTabId: null,
  selectedEdgeId: null,
  topZ: persisted.topZ,

  syncPlacements: (tabIds) => {
    const ids = new Set(tabIds);
    const { placements, edges, groups: prevGroups } = get();

    // 1) Prune groups: drop closed members; a group below 2 members dissolves
    //    (its surviving member, if any, re-inherits the group's rect as a card).
    const groups: CardGroup[] = [];
    const dissolvedSurvivor: { gid: string; tabId: string }[] = [];
    for (const g of prevGroups) {
      const members = g.tabIds.filter((t) => ids.has(t));
      if (members.length >= 2) {
        groups.push({
          id: g.id,
          tabIds: members,
          activeId: members.includes(g.activeId) ? g.activeId : members[0],
        });
      } else if (members.length === 1) {
        dissolvedSurvivor.push({ gid: g.id, tabId: members[0] });
      }
    }
    const groupsChanged =
      groups.length !== prevGroups.length ||
      groups.some((g, i) => {
        const p = prevGroups[i];
        return (
          !p ||
          p.id !== g.id ||
          p.activeId !== g.activeId ||
          p.tabIds.length !== g.tabIds.length ||
          p.tabIds.some((t, j) => t !== g.tabIds[j])
        );
      });
    const groupedTabs = new Set(groups.flatMap((g) => g.tabIds));
    const liveGroupIds = new Set(groups.map((g) => g.id));

    let changed = groupsChanged;
    const next: Record<string, CardRect> = {};
    // Keep placements for live group ids and live ungrouped tabs; drop closed
    // tabs, now-grouped tabs (the group owns the rect), and dead group ids.
    for (const [key, rect] of Object.entries(placements)) {
      if (liveGroupIds.has(key) || (ids.has(key) && !groupedTabs.has(key))) next[key] = rect;
      else changed = true;
    }
    // A dissolved group's solo survivor takes over the group's old rect.
    for (const { gid, tabId } of dissolvedSurvivor) {
      if (!next[tabId] && placements[gid]) {
        next[tabId] = placements[gid];
        changed = true;
      }
    }
    // Add placements for ungrouped tabs that still lack one, grid-flowed after
    // the current count so they don't stack; seed at the kind's default size.
    const kindOf = new Map(useTabsStore.getState().tabs.map((t) => [t.id, t.kind]));
    let topZ = get().topZ;
    let placedCount = Object.keys(next).length;
    for (const id of tabIds) {
      if (next[id] || groupedTabs.has(id)) continue;
      const { x, y } = placeAt(placedCount);
      const { w, h } = cardDefaultSize(kindOf.get(id));
      next[id] = { x, y, w, h, z: ++topZ };
      placedCount += 1;
      changed = true;
    }
    // Drop edges whose endpoints have closed (edges reference tab ids).
    const liveEdges = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
    const edgesChanged = liveEdges.length !== edges.length;
    if (changed) {
      // Rebalance z to a compact 1..N range (by current stacking order) so
      // repeated bring-to-front / send-to-back never grows the z spread (or the
      // persisted state) without bound.
      const ordered = Object.entries(next).sort((a, b) => a[1].z - b[1].z);
      ordered.forEach(([id], i) => {
        next[id] = { ...next[id], z: i + 1 };
      });
      set({
        placements: next,
        groups,
        topZ: ordered.length || 1,
        ...(edgesChanged ? { edges: liveEdges } : {}),
      });
    } else if (edgesChanged) {
      set({ edges: liveEdges });
    }
  },

  setPos: (tabId, x, y) =>
    set((s) => {
      const cur = s.placements[tabId];
      if (!cur) return {};
      return { placements: { ...s.placements, [tabId]: { ...cur, x, y } } };
    }),

  setSize: (tabId, w, h) =>
    set((s) => {
      const cur = s.placements[tabId];
      if (!cur) return {};
      const kind = useTabsStore.getState().tabs.find((t) => t.id === tabId)?.kind;
      const min = cardMinSize(kind);
      return {
        placements: {
          ...s.placements,
          [tabId]: {
            ...cur,
            w: Math.max(min.w, w),
            h: Math.max(min.h, h),
          },
        },
      };
    }),

  bringToFront: (tabId) =>
    set((s) => {
      const cur = s.placements[tabId];
      if (!cur) return {};
      const z = s.topZ + 1;
      return {
        topZ: z,
        placements: { ...s.placements, [tabId]: { ...cur, z } },
      };
    }),

  sendToBack: (tabId) =>
    set((s) => {
      const cur = s.placements[tabId];
      if (!cur) return {};
      const minZ = Math.min(...Object.values(s.placements).map((p) => p.z));
      return { placements: { ...s.placements, [tabId]: { ...cur, z: minZ - 1 } } };
    }),

  setFocused: (tabId) => set({ focusedTabId: tabId }),

  addEdge: (from, to, fromSide, toSide) =>
    set((s) => {
      if (from === to || !s.placements[from] || !s.placements[to]) return {};
      const id = edgeId(from, to);
      const rev = edgeId(to, from);
      if (s.edges.some((e) => e.id === id || e.id === rev)) return {};
      const edge: Edge = {
        id,
        from,
        to,
        ...(fromSide ? { fromSide } : {}),
        ...(toSide ? { toSide } : {}),
      };
      return { edges: [...s.edges, edge], selectedEdgeId: id };
    }),

  removeEdge: (id) =>
    set((s) => ({
      edges: s.edges.filter((e) => e.id !== id),
      selectedEdgeId: s.selectedEdgeId === id ? null : s.selectedEdgeId,
    })),

  selectEdge: (id) => set({ selectedEdgeId: id }),

  setEdgeStyle: (style) => set({ edgeStyle: style }),
  toggleEdgeStyle: () =>
    set((s) => ({ edgeStyle: s.edgeStyle === 'curve' ? 'orthogonal' : 'curve' })),

  mergeInto: (targetKey, draggedTabId) =>
    set((s) => {
      if (targetKey === draggedTabId) return {};
      // Pop the dragged tab out of any group it's already in (it joins exactly
      // one group at a time); a left-behind singleton dissolves.
      let groups = s.groups
        .map((g) =>
          g.tabIds.includes(draggedTabId)
            ? { ...g, tabIds: g.tabIds.filter((t) => t !== draggedTabId) }
            : g,
        )
        .filter((g) => g.tabIds.length >= 2);
      const placements = { ...s.placements };

      const targetGroup = groups.find((g) => g.id === targetKey);
      if (targetGroup) {
        // Drop into an existing group.
        if (targetGroup.tabIds.includes(draggedTabId)) return {};
        groups = groups.map((g) =>
          g.id === targetGroup.id
            ? { ...g, tabIds: [...g.tabIds, draggedTabId], activeId: draggedTabId }
            : g,
        );
      } else {
        // Form a new group from the (ungrouped) target + dragged.
        const rect = placements[targetKey];
        if (!rect) return {};
        const id = newGroupId();
        groups = [...groups, { id, tabIds: [targetKey, draggedTabId], activeId: draggedTabId }];
        placements[id] = { ...rect, z: s.topZ + 1 };
        delete placements[targetKey];
      }
      delete placements[draggedTabId];
      // Re-key any group placements left without members (defensive).
      return { groups, placements, topZ: s.topZ + 1, focusedTabId: draggedTabId };
    }),

  setGroupActive: (groupId, tabId) =>
    set((s) => ({
      groups: s.groups.map((g) =>
        g.id === groupId && g.tabIds.includes(tabId) ? { ...g, activeId: tabId } : g,
      ),
    })),

  popOutTab: (tabId) =>
    set((s) => {
      const g = s.groups.find((gr) => gr.tabIds.includes(tabId));
      if (!g) return {};
      const groupRect = s.placements[g.id];
      const remaining = g.tabIds.filter((t) => t !== tabId);
      const placements = { ...s.placements };
      // The popped tab gets its own card, offset from the group so it's visible.
      placements[tabId] = {
        ...(groupRect ?? { x: 80, y: 80, w: CARD_DEFAULT.w, h: CARD_DEFAULT.h, z: 1 }),
        x: (groupRect?.x ?? 80) + 40,
        y: (groupRect?.y ?? 80) + 40,
        z: s.topZ + 1,
      };
      if (remaining.length >= 2) {
        const groups = s.groups.map((gr) =>
          gr.id === g.id
            ? { ...gr, tabIds: remaining, activeId: remaining.includes(gr.activeId) ? gr.activeId : remaining[0] }
            : gr,
        );
        return { groups, placements, topZ: s.topZ + 1, focusedTabId: tabId };
      }
      // Down to one member → dissolve: the survivor inherits the group rect.
      const survivor = remaining[0];
      if (survivor && groupRect) placements[survivor] = groupRect;
      delete placements[g.id];
      return {
        groups: s.groups.filter((gr) => gr.id !== g.id),
        placements,
        topZ: s.topZ + 1,
        focusedTabId: tabId,
      };
    }),

  panBy: (dx, dy) =>
    set((s) => ({
      viewport: { ...s.viewport, panX: s.viewport.panX + dx, panY: s.viewport.panY + dy },
    })),

  setPan: (panX, panY) => set((s) => ({ viewport: { ...s.viewport, panX, panY } })),

  zoomAt: (factor, cx, cy) =>
    set((s) => {
      const { panX, panY, scale } = s.viewport;
      const nextScale = clamp(scale * factor, SCALE_MIN, SCALE_MAX);
      if (nextScale === scale) return {};
      // Canvas-space point currently under the cursor; keep it fixed across zoom.
      const px = (cx - panX) / scale;
      const py = (cy - panY) / scale;
      return {
        viewport: {
          scale: nextScale,
          panX: cx - px * nextScale,
          panY: cy - py * nextScale,
        },
      };
    }),

  resetView: () => set({ viewport: { panX: 0, panY: 0, scale: 1 } }),

  fitToContent: (containerW, containerH) => {
    const rects = Object.values(get().placements);
    if (rects.length === 0) {
      set({ viewport: { panX: 0, panY: 0, scale: 1 } });
      return;
    }
    const minX = Math.min(...rects.map((r) => r.x));
    const minY = Math.min(...rects.map((r) => r.y));
    const maxX = Math.max(...rects.map((r) => r.x + r.w));
    const maxY = Math.max(...rects.map((r) => r.y + r.h));
    const pad = 80;
    const contentW = maxX - minX + pad * 2;
    const contentH = maxY - minY + pad * 2;
    const scale = clamp(
      Math.min(containerW / contentW, containerH / contentH),
      SCALE_MIN,
      SCALE_MAX,
    );
    // Center the content bounding box in the container.
    const panX = (containerW - (maxX - minX) * scale) / 2 - minX * scale;
    const panY = (containerH - (maxY - minY) * scale) / 2 - minY * scale;
    set({ viewport: { panX, panY, scale } });
  },
}));

/**
 * Prune placements + edges when tabs close, mirroring the grid store's orphan
 * sweep (`features/tabs/grid.ts`). Gate on the `tabs` array identity so we only
 * run on an actual add/remove/reorder, not every unrelated store write.
 */
let lastTabsRef: unknown = null;
useTabsStore.subscribe((state) => {
  if (state.tabs === lastTabsRef) return;
  lastTabsRef = state.tabs;
  useCanvasStore.getState().syncPlacements(state.tabs.map((t) => t.id));
});

/**
 * Persist the canvas layout (placements + viewport + edges) so an arrangement
 * survives reloads and app restarts. Microtask-debounced so a drag (many `set`s)
 * writes once. Placements/edges are keyed by tab id; on restart, tabs the session
 * doesn't restore are pruned by `syncPlacements`, so a stale entry never breaks
 * the canvas.
 */
let saveQueued = false;
useCanvasStore.subscribe(() => {
  if (typeof localStorage === 'undefined' || saveQueued) return;
  saveQueued = true;
  queueMicrotask(() => {
    saveQueued = false;
    try {
      const { placements, viewport, edges, edgeStyle, groups } = useCanvasStore.getState();
      localStorage.setItem(
        PERSIST_KEY,
        JSON.stringify({ placements, viewport, edges, edgeStyle, groups }),
      );
    } catch {
      // Ignore quota / serialization failures — persistence is best-effort.
    }
  });
});
