import { create } from 'zustand';
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
/** A directed connection between two cards (by tab id). Undirected for dedup. */
export type Edge = { id: string; from: string; to: string };

export const CARD_DEFAULT = { w: 560, h: 380 } as const;
export const CARD_MIN = { w: 240, h: 160 } as const;
export const SCALE_MIN = 0.2;
export const SCALE_MAX = 2.5;

// Auto-placement: lay fresh cards out in a loose grid in canvas space.
const PLACE = { cols: 3, gapX: 600, gapY: 430, x0: 80, y0: 80 } as const;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

const edgeId = (from: string, to: string) => `${from}~${to}`;

const PERSIST_KEY = 'maru.canvas.v1';

type Persisted = {
  placements: Record<string, CardRect>;
  viewport: Viewport;
  edges: Edge[];
  topZ: number;
};

/** Read the saved canvas layout (placements + viewport + edges). Fails closed to empty. */
function loadPersisted(): Persisted {
  const fallback: Persisted = {
    placements: {},
    viewport: { panX: 0, panY: 0, scale: 1 },
    edges: [],
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
          edges.push({ id: isStr(e.id) ? e.id : edgeId(e.from, e.to), from: e.from, to: e.to });
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
    return { placements, viewport, edges, topZ: zs.length ? Math.max(1, ...zs) : 1 };
  } catch {
    return fallback;
  }
}

type CanvasState = {
  /** tabId → rect+z in canvas coordinates. */
  placements: Record<string, CardRect>;
  /** Node connections between cards. */
  edges: Edge[];
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
  /** Connect two cards (no-op on self / duplicate, either direction). */
  addEdge: (from: string, to: string) => void;
  removeEdge: (id: string) => void;
  selectEdge: (id: string | null) => void;
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
  viewport: persisted.viewport,
  focusedTabId: null,
  selectedEdgeId: null,
  topZ: persisted.topZ,

  syncPlacements: (tabIds) => {
    const ids = new Set(tabIds);
    const { placements, edges } = get();
    let changed = false;
    const next: Record<string, CardRect> = {};
    // Keep placements whose tab still exists.
    for (const [id, rect] of Object.entries(placements)) {
      if (ids.has(id)) next[id] = rect;
      else changed = true;
    }
    // Add placements for tabs that don't have one yet, grid-flowed after the
    // current count so they don't stack on existing cards.
    let topZ = get().topZ;
    let placedCount = Object.keys(next).length;
    for (const id of tabIds) {
      if (next[id]) continue;
      const { x, y } = placeAt(placedCount);
      next[id] = { x, y, w: CARD_DEFAULT.w, h: CARD_DEFAULT.h, z: ++topZ };
      placedCount += 1;
      changed = true;
    }
    // Drop edges whose endpoints have closed.
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
      return {
        placements: {
          ...s.placements,
          [tabId]: {
            ...cur,
            w: Math.max(CARD_MIN.w, w),
            h: Math.max(CARD_MIN.h, h),
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

  addEdge: (from, to) =>
    set((s) => {
      if (from === to || !s.placements[from] || !s.placements[to]) return {};
      const id = edgeId(from, to);
      const rev = edgeId(to, from);
      if (s.edges.some((e) => e.id === id || e.id === rev)) return {};
      return { edges: [...s.edges, { id, from, to }], selectedEdgeId: id };
    }),

  removeEdge: (id) =>
    set((s) => ({
      edges: s.edges.filter((e) => e.id !== id),
      selectedEdgeId: s.selectedEdgeId === id ? null : s.selectedEdgeId,
    })),

  selectEdge: (id) => set({ selectedEdgeId: id }),

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
      const { placements, viewport, edges } = useCanvasStore.getState();
      localStorage.setItem(PERSIST_KEY, JSON.stringify({ placements, viewport, edges }));
    } catch {
      // Ignore quota / serialization failures — persistence is best-effort.
    }
  });
});
