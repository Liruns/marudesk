import { create } from 'zustand';
import type { TabKind } from '../../../shared/browser';
import { SYSTEM_WORKSPACE_ID, type WorkspaceId } from '../../../shared/workspace';
import { useTabsStore } from '../tabs/store';
import { useWorkspaceDeckStore } from '../workspaces/store';

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
 *
 * **Multiple named canvases (= saved layouts).** A workspace owns an ordered set
 * of named {@link CanvasDoc}s and one is *open* at a time; switching loads a
 * different layout. The currently-open canvas's spatial state is hoisted to the
 * top-level fields below (the live working copy every action mutates and
 * `CanvasStage` renders); the other canvases (and other workspaces') live in
 * {@link byWorkspace}, synced from the working copy at well-defined points
 * (switch / persist / prune). Membership is implicit: a tab belongs to whichever
 * canvas of its workspace holds its placement; new tabs land on the open canvas.
 */

export type CardRect = {
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  /** Locked cards can't be moved or resized (guards accidental edits). */
  locked?: boolean;
  /** Pre-maximize rect; present iff the card is currently maximized. */
  preMax?: { x: number; y: number; w: number; h: number };
};
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

let canvasSeq = 0;
function newCanvasId(): string {
  canvasSeq += 1;
  return `cv_${canvasSeq.toString(36)}_${Math.round(performance.now()).toString(36)}`;
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

/** Persist key for the per-workspace multi-canvas state (v2). */
const PERSIST_KEY = 'maru.canvas.v2';
/** Legacy single-canvas key (v1); migrated into the default canvas on first load. */
const LEGACY_KEY = 'maru.canvas.v1';

/**
 * The workspace bucket key for a (possibly null) active workspace. No active
 * user workspace ⇒ the System workspace, which is where tabs live then — so this
 * matches `tab.workspaceId` and keeps placement in step with `CanvasStage`'s
 * render filter (which shows all tabs when `activeWorkspaceId` is null).
 */
const wsKeyOf = (id: WorkspaceId | null | undefined): string => id ?? SYSTEM_WORKSPACE_ID;

/**
 * A named canvas = a saved layout: the panels placed on it (by tab id), how they
 * are wired + grouped, and the saved view. The open canvas's fields are hoisted
 * to the store's top level; the rest live in {@link byWorkspace}.
 */
export type CanvasDoc = {
  id: string;
  name: string;
  createdAt: number;
  placements: Record<string, CardRect>;
  edges: Edge[];
  edgeStyle: EdgeStyle;
  groups: CardGroup[];
  viewport: Viewport;
  /** Monotonic z allocator so bringToFront always wins (per-canvas). */
  topZ: number;
};

/** A workspace's ordered set of named canvases + which one is open. */
type WorkspaceCanvases = {
  /** Canvas ids in display order (switcher order). */
  order: string[];
  /** The open canvas id (whose state is the store's top-level working copy). */
  activeId: string;
  canvases: Record<string, CanvasDoc>;
};

function emptyCanvas(name: string): CanvasDoc {
  return {
    id: newCanvasId(),
    name,
    createdAt: Date.now(),
    placements: {},
    edges: [],
    edgeStyle: 'curve',
    groups: [],
    viewport: { panX: 0, panY: 0, scale: 1 },
    topZ: 1,
  };
}

/** A fresh bucket with a single default canvas. */
function defaultBucket(): WorkspaceCanvases {
  const doc = emptyCanvas('Canvas 1');
  return { order: [doc.id], activeId: doc.id, canvases: { [doc.id]: doc } };
}

/* ── Persistence (de)serialization ──────────────────────────────────────── */

function parseRect(val: unknown): CardRect | null {
  if (typeof val !== 'object' || val === null) return null;
  const v = val as Record<string, unknown>;
  if (!(isNum(v.x) && isNum(v.y) && isNum(v.w) && isNum(v.h))) return null;
  const pm = v.preMax;
  const preMax =
    pm && typeof pm === 'object' && isNum((pm as Record<string, unknown>).x) &&
    isNum((pm as Record<string, unknown>).y) && isNum((pm as Record<string, unknown>).w) &&
    isNum((pm as Record<string, unknown>).h)
      ? {
          x: (pm as Record<string, number>).x,
          y: (pm as Record<string, number>).y,
          w: (pm as Record<string, number>).w,
          h: (pm as Record<string, number>).h,
        }
      : undefined;
  return {
    x: v.x,
    y: v.y,
    w: v.w,
    h: v.h,
    z: isNum(v.z) ? v.z : 1,
    ...(v.locked === true ? { locked: true } : {}),
    ...(preMax ? { preMax } : {}),
  };
}

function parsePlacements(raw: unknown): Record<string, CardRect> {
  const out: Record<string, CardRect> = {};
  if (typeof raw === 'object' && raw !== null) {
    for (const [id, val] of Object.entries(raw as Record<string, unknown>)) {
      const rect = parseRect(val);
      if (rect) out[id] = rect;
    }
  }
  return out;
}

function parseEdges(raw: unknown): Edge[] {
  const out: Edge[] = [];
  if (Array.isArray(raw)) {
    for (const val of raw) {
      if (typeof val !== 'object' || val === null) continue;
      const e = val as Record<string, unknown>;
      if (isStr(e.from) && isStr(e.to) && e.from !== e.to) {
        out.push({
          id: isStr(e.id) ? e.id : edgeId(e.from, e.to),
          from: e.from,
          to: e.to,
          ...(isEdgeSide(e.fromSide) ? { fromSide: e.fromSide } : {}),
          ...(isEdgeSide(e.toSide) ? { toSide: e.toSide } : {}),
        });
      }
    }
  }
  return out;
}

function parseGroups(raw: unknown): CardGroup[] {
  const out: CardGroup[] = [];
  if (Array.isArray(raw)) {
    for (const val of raw) {
      if (typeof val !== 'object' || val === null) continue;
      const g = val as Record<string, unknown>;
      const tabIds = Array.isArray(g.tabIds) ? g.tabIds.filter(isStr) : [];
      if (isStr(g.id) && tabIds.length >= 2 && isStr(g.activeId)) {
        out.push({
          id: g.id,
          tabIds,
          activeId: tabIds.includes(g.activeId) ? g.activeId : tabIds[0],
        });
      }
    }
  }
  return out;
}

function parseViewport(raw: unknown): Viewport {
  if (typeof raw === 'object' && raw !== null) {
    const v = raw as Record<string, unknown>;
    if (isNum(v.panX) && isNum(v.panY) && isNum(v.scale)) {
      return { panX: v.panX, panY: v.panY, scale: clamp(v.scale, SCALE_MIN, SCALE_MAX) };
    }
  }
  return { panX: 0, panY: 0, scale: 1 };
}

function parseCanvasDoc(raw: unknown): CanvasDoc | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!isStr(r.id)) return null;
  const placements = parsePlacements(r.placements);
  const zs = Object.values(placements).map((p) => p.z);
  return {
    id: r.id,
    name: isStr(r.name) ? r.name : 'Canvas',
    createdAt: isNum(r.createdAt) ? r.createdAt : Date.now(),
    placements,
    edges: parseEdges(r.edges),
    edgeStyle: isEdgeStyle(r.edgeStyle) ? r.edgeStyle : 'curve',
    groups: parseGroups(r.groups),
    viewport: parseViewport(r.viewport),
    topZ: isNum(r.topZ) ? r.topZ : zs.length ? Math.max(1, ...zs) : 1,
  };
}

function parseBucket(raw: unknown): WorkspaceCanvases | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const canvases: Record<string, CanvasDoc> = {};
  if (typeof r.canvases === 'object' && r.canvases !== null) {
    for (const val of Object.values(r.canvases as Record<string, unknown>)) {
      const doc = parseCanvasDoc(val);
      if (doc) canvases[doc.id] = doc;
    }
  }
  const ids = Object.keys(canvases);
  if (ids.length === 0) return null;
  const order = (Array.isArray(r.order) ? r.order.filter(isStr) : []).filter((id) => canvases[id]);
  for (const id of ids) if (!order.includes(id)) order.push(id);
  const activeId = isStr(r.activeId) && canvases[r.activeId] ? r.activeId : order[0];
  return { order, activeId, canvases };
}

/**
 * Read the saved per-workspace canvases (v2). On a first run after the v1 single
 * canvas, its placements are surfaced as a read-only `legacy` pool keyed by tab
 * id, so each tab keeps its saved position on whichever workspace's canvas it
 * opens on (v1 placements were global — mixed across workspaces). v1 edges /
 * groups are not migrated (a one-time loss; they re-form, and v2 persists them).
 */
function loadPersisted(): {
  byWorkspace: Record<string, WorkspaceCanvases>;
  legacy: Record<string, CardRect> | null;
} {
  try {
    if (typeof localStorage === 'undefined') return { byWorkspace: {}, legacy: null };
    const rawV2 = localStorage.getItem(PERSIST_KEY);
    if (rawV2) {
      const data: unknown = JSON.parse(rawV2);
      const byWorkspace: Record<string, WorkspaceCanvases> = {};
      if (typeof data === 'object' && data !== null) {
        const rec = (data as Record<string, unknown>).byWorkspace;
        if (typeof rec === 'object' && rec !== null) {
          for (const [ws, val] of Object.entries(rec as Record<string, unknown>)) {
            const bucket = parseBucket(val);
            if (bucket) byWorkspace[ws] = bucket;
          }
        }
      }
      return { byWorkspace, legacy: null };
    }
    const rawV1 = localStorage.getItem(LEGACY_KEY);
    if (rawV1) {
      const data: unknown = JSON.parse(rawV1);
      if (typeof data === 'object' && data !== null) {
        return { byWorkspace: {}, legacy: parsePlacements((data as Record<string, unknown>).placements) };
      }
    }
    return { byWorkspace: {}, legacy: null };
  } catch {
    return { byWorkspace: {}, legacy: null };
  }
}

type CanvasState = {
  /** All workspaces' canvases except the open one's live working copy. */
  byWorkspace: Record<string, WorkspaceCanvases>;
  /** Workspace key whose canvas is currently the working copy ({@link wsKeyOf}). */
  wsKey: string;
  /** The open canvas id within {@link wsKey}. */
  activeCanvasId: string;

  /* ── working copy of the open canvas (rendered by CanvasStage) ── */
  /** tabId → rect+z in canvas coordinates. */
  placements: Record<string, CardRect>;
  /** Node connections between cards. */
  edges: Edge[];
  /** How all edges are drawn (curve vs orthogonal) — a canvas-wide toggle. */
  edgeStyle: EdgeStyle;
  /** Merged card stacks (tab groups). Each owns a placement keyed by its id. */
  groups: CardGroup[];
  viewport: Viewport;
  /** Monotonic z allocator so bringToFront always wins. */
  topZ: number;

  /* ── ephemeral (reset on canvas/workspace switch) ── */
  focusedTabId: string | null;
  /** Multi-selected placement keys (Figma marquee / shift-click); in-memory. */
  selection: string[];
  /** The currently-selected edge (for delete), or null. */
  selectedEdgeId: string | null;
};

/** A canvas's switcher-facing summary (id + name + open flag). */
export type CanvasSummary = { id: string; name: string; active: boolean };

type CanvasActions = {
  /** Add placements for new tabs, drop placements + edges for closed ones. */
  syncPlacements: (tabIds: readonly string[]) => void;
  setPos: (tabId: string, x: number, y: number) => void;
  setSize: (tabId: string, w: number, h: number) => void;
  bringToFront: (tabId: string) => void;
  sendToBack: (tabId: string) => void;
  setFocused: (tabId: string | null) => void;
  /** Replace the multi-selection (placement keys). */
  setSelection: (keys: string[]) => void;
  /** Add/remove one key from the multi-selection (shift-click). */
  toggleSelection: (key: string) => void;
  /** Clear the multi-selection. */
  clearSelection: () => void;
  /** Nudge every selected card by (dx,dy) in canvas units (skips locked). */
  moveSelectionBy: (keys: string[], base: Record<string, { x: number; y: number }>, dx: number, dy: number) => void;
  /** Connect two cards (no-op on self / duplicate, either direction). Sides pin
      each end to a face; omit for auto (center-ray) anchoring. */
  addEdge: (from: string, to: string, fromSide?: EdgeSide, toSide?: EdgeSide) => void;
  removeEdge: (id: string) => void;
  selectEdge: (id: string | null) => void;
  /** Set / toggle how edges render (curve ⇄ orthogonal); persisted. */
  setEdgeStyle: (style: EdgeStyle) => void;
  toggleEdgeStyle: () => void;
  /** Lock / unlock a card or group (locked = no move/resize). */
  toggleLock: (key: string) => void;
  /** Maximize a card to fill `viewport` (canvas coords) / restore. */
  toggleMaximize: (key: string, viewport: { x: number; y: number; w: number; h: number }) => void;
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

  /* ── named-canvas (saved-layout) management ── */
  /** The open workspace's canvases, in switcher order. */
  listCanvases: () => CanvasSummary[];
  /** Open a different canvas in the current workspace (snapshots the open one). */
  switchCanvas: (id: string) => void;
  /** Create a fresh empty canvas, open it, and return its id. */
  newCanvas: (name?: string) => string;
  /** Rename a canvas (any in the current workspace). */
  renameCanvas: (id: string, name: string) => void;
  /** Delete a canvas + close its panels. No-op on the last canvas; opens a
      sibling when deleting the open one. Returns the member tab ids to close. */
  deleteCanvas: (id: string) => string[];
};

function placeAt(index: number): { x: number; y: number } {
  const col = index % PLACE.cols;
  const row = Math.floor(index / PLACE.cols);
  return { x: PLACE.x0 + col * PLACE.gapX, y: PLACE.y0 + row * PLACE.gapY };
}

const initial = loadPersisted();
// One-time v1→v2 migration: a read-only by-tab-id pool of saved positions that
// `syncPlacements` consults so each tab keeps its v1 spot on its own canvas.
const legacyPlacements: Record<string, CardRect> | null = initial.legacy;

/** Pull the open canvas's working-copy fields into a {@link CanvasDoc}. */
function activeDoc(s: CanvasState): CanvasDoc {
  const bucket = s.byWorkspace[s.wsKey];
  const base = bucket?.canvases[s.activeCanvasId];
  return {
    id: s.activeCanvasId,
    name: base?.name ?? 'Canvas 1',
    createdAt: base?.createdAt ?? Date.now(),
    placements: s.placements,
    edges: s.edges,
    edgeStyle: s.edgeStyle,
    groups: s.groups,
    viewport: s.viewport,
    topZ: s.topZ,
  };
}

/** byWorkspace with the open canvas's working copy folded back in. */
function snapshotByWorkspace(s: CanvasState): Record<string, WorkspaceCanvases> {
  const bucket = s.byWorkspace[s.wsKey];
  if (!bucket) return s.byWorkspace;
  const doc = activeDoc(s);
  return {
    ...s.byWorkspace,
    [s.wsKey]: { ...bucket, canvases: { ...bucket.canvases, [doc.id]: doc } },
  };
}

/** The top-level working-copy fields drawn from a {@link CanvasDoc}. */
function workingCopy(doc: CanvasDoc): Pick<
  CanvasState,
  'placements' | 'edges' | 'edgeStyle' | 'groups' | 'viewport' | 'topZ'
> {
  return {
    placements: doc.placements,
    edges: doc.edges,
    edgeStyle: doc.edgeStyle,
    groups: doc.groups,
    viewport: doc.viewport,
    topZ: doc.topZ,
  };
}

/** Fresh ephemeral (selection/focus/edge) state — reset on canvas/workspace switch. */
const ephemeral = (): Pick<CanvasState, 'focusedTabId' | 'selection' | 'selectedEdgeId'> => ({
  focusedTabId: null,
  selection: [],
  selectedEdgeId: null,
});

// Resolve the initial open workspace/canvas from whatever the deck store knows
// at module-eval (usually no active workspace yet → NONE_WS; the deck
// subscription re-homes onto the real workspace once it loads).
const initialWsKey = wsKeyOf(useWorkspaceDeckStore.getState().activeWorkspaceId);
function seedBucket(byWorkspace: Record<string, WorkspaceCanvases>, wsKey: string): {
  byWorkspace: Record<string, WorkspaceCanvases>;
  bucket: WorkspaceCanvases;
} {
  const existing = byWorkspace[wsKey];
  if (existing) return { byWorkspace, bucket: existing };
  const bucket = defaultBucket();
  return { byWorkspace: { ...byWorkspace, [wsKey]: bucket }, bucket };
}

const seeded = seedBucket(initial.byWorkspace, initialWsKey);
const seedActive = seeded.bucket.canvases[seeded.bucket.activeId];

export const useCanvasStore = create<CanvasState & CanvasActions>((set, get) => ({
  byWorkspace: seeded.byWorkspace,
  wsKey: initialWsKey,
  activeCanvasId: seeded.bucket.activeId,
  ...workingCopy(seedActive),
  focusedTabId: null,
  selection: [],
  selectedEdgeId: null,

  syncPlacements: (tabIds) => {
    const ids = new Set(tabIds);
    const state = get();
    const { placements, edges, groups: prevGroups } = state;
    const tabsNow = useTabsStore.getState().tabs;
    const kindOf = new Map(tabsNow.map((t) => [t.id, t.kind]));
    const wsOf = new Map(tabsNow.map((t) => [t.id, wsKeyOf(t.workspaceId)]));

    // Prune closed tabs from the OTHER (snapshotted) canvases too, so a tab
    // closed from the classic shell while its canvas is in the background never
    // leaves a ghost placement that resurfaces on switch.
    let bwChanged = false;
    const byWorkspace: Record<string, WorkspaceCanvases> = {};
    for (const [ws, bucket] of Object.entries(state.byWorkspace)) {
      const canvases: Record<string, CanvasDoc> = {};
      for (const [cid, doc] of Object.entries(bucket.canvases)) {
        // The open canvas's authoritative copy is the working copy below.
        if (ws === state.wsKey && cid === state.activeCanvasId) {
          canvases[cid] = doc;
          continue;
        }
        const liveGroupIds = new Set<string>();
        const nextGroups: CardGroup[] = [];
        for (const g of doc.groups) {
          const members = g.tabIds.filter((t) => ids.has(t));
          if (members.length >= 2) {
            nextGroups.push({ ...g, tabIds: members, activeId: members.includes(g.activeId) ? g.activeId : members[0] });
            liveGroupIds.add(g.id);
          }
        }
        const groupedTabs = new Set(nextGroups.flatMap((g) => g.tabIds));
        const nextPlacements: Record<string, CardRect> = {};
        for (const [key, rect] of Object.entries(doc.placements)) {
          if (liveGroupIds.has(key) || (ids.has(key) && !groupedTabs.has(key))) nextPlacements[key] = rect;
        }
        const nextEdges = doc.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
        const docChanged =
          Object.keys(nextPlacements).length !== Object.keys(doc.placements).length ||
          nextEdges.length !== doc.edges.length ||
          nextGroups.length !== doc.groups.length;
        canvases[cid] = docChanged
          ? { ...doc, placements: nextPlacements, edges: nextEdges, groups: nextGroups }
          : doc;
        if (docChanged) bwChanged = true;
      }
      byWorkspace[ws] = bucket.canvases === canvases ? bucket : { ...bucket, canvases };
    }

    // Tab ids already placed on a NON-open canvas of the open workspace (so they
    // aren't re-added to the open canvas).
    const placedElsewhere = new Set<string>();
    const openBucket = byWorkspace[state.wsKey];
    if (openBucket) {
      for (const [cid, doc] of Object.entries(openBucket.canvases)) {
        if (cid === state.activeCanvasId) continue;
        for (const k of Object.keys(doc.placements)) placedElsewhere.add(k);
      }
    }

    // 1) Prune groups on the OPEN canvas: drop closed members; a group below 2
    //    members dissolves (its surviving member re-inherits the rect as a card).
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
    // Keep placements for live group ids and live ungrouped tabs of the OPEN
    // workspace; drop closed tabs, now-grouped tabs, dead group ids, and any
    // tab that no longer belongs to the open workspace.
    for (const [key, rect] of Object.entries(placements)) {
      const isGroup = liveGroupIds.has(key);
      const keepTab = ids.has(key) && !groupedTabs.has(key) && wsOf.get(key) === state.wsKey;
      if (isGroup || keepTab) next[key] = rect;
      else changed = true;
    }
    // A dissolved group's solo survivor takes over the group's old rect.
    for (const { gid, tabId } of dissolvedSurvivor) {
      if (!next[tabId] && placements[gid]) {
        next[tabId] = placements[gid];
        changed = true;
      }
    }
    // Add placements for open-workspace tabs that still lack one (and aren't
    // placed on a sibling canvas), grid-flowed after the current count so they
    // don't stack; restore a migrated v1 rect when one matches the tab id.
    let topZ = state.topZ;
    let placedCount = Object.keys(next).length;
    for (const id of tabIds) {
      if (next[id] || groupedTabs.has(id) || placedElsewhere.has(id)) continue;
      if (wsOf.get(id) !== state.wsKey) continue;
      const legacyRect = legacyPlacements?.[id];
      if (legacyRect) {
        next[id] = legacyRect;
      } else {
        const { x, y } = placeAt(placedCount);
        const { w, h } = cardDefaultSize(kindOf.get(id));
        next[id] = { x, y, w, h, z: ++topZ };
        placedCount += 1;
      }
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
        ...(bwChanged ? { byWorkspace } : {}),
      });
    } else if (edgesChanged || bwChanged) {
      set({
        ...(edgesChanged ? { edges: liveEdges } : {}),
        ...(bwChanged ? { byWorkspace } : {}),
      });
    }
  },

  setPos: (tabId, x, y) =>
    set((s) => {
      const cur = s.placements[tabId];
      if (!cur || cur.locked) return {};
      return { placements: { ...s.placements, [tabId]: { ...cur, x, y } } };
    }),

  setSize: (tabId, w, h) =>
    set((s) => {
      const cur = s.placements[tabId];
      if (!cur || cur.locked) return {};
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

  setSelection: (keys) => set({ selection: [...new Set(keys)] }),
  toggleSelection: (key) =>
    set((s) => ({
      selection: s.selection.includes(key)
        ? s.selection.filter((k) => k !== key)
        : [...s.selection, key],
    })),
  clearSelection: () => set((s) => (s.selection.length ? { selection: [] } : {})),
  moveSelectionBy: (keys, base, dx, dy) =>
    set((s) => {
      const next = { ...s.placements };
      let changed = false;
      for (const key of keys) {
        const cur = next[key];
        const b = base[key];
        if (!cur || cur.locked || !b) continue;
        next[key] = { ...cur, x: b.x + dx, y: b.y + dy };
        changed = true;
      }
      return changed ? { placements: next } : {};
    }),

  addEdge: (from, to, fromSide, toSide) =>
    set((s) => {
      if (from === to || !s.placements[from] || !s.placements[to]) return {};
      // Directed: A→B and B→A are distinct edges (n:n). Only dedup the exact
      // ordered pair so a node can fan out to / in from many others.
      const id = edgeId(from, to);
      if (s.edges.some((e) => e.id === id)) return {};
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

  toggleLock: (key) =>
    set((s) => {
      const cur = s.placements[key];
      if (!cur) return {};
      return { placements: { ...s.placements, [key]: { ...cur, locked: !cur.locked } } };
    }),

  toggleMaximize: (key, vp) =>
    set((s) => {
      const cur = s.placements[key];
      if (!cur) return {};
      if (cur.preMax) {
        // Restore the pre-maximize rect.
        const { preMax, ...rest } = cur;
        return {
          placements: {
            ...s.placements,
            [key]: { ...rest, x: preMax.x, y: preMax.y, w: preMax.w, h: preMax.h },
          },
        };
      }
      // Maximize: fill the viewport, remembering the prior rect to restore to.
      return {
        placements: {
          ...s.placements,
          [key]: {
            ...cur,
            preMax: { x: cur.x, y: cur.y, w: cur.w, h: cur.h },
            x: vp.x,
            y: vp.y,
            w: vp.w,
            h: vp.h,
          },
        },
      };
    }),

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

  listCanvases: () => {
    const s = get();
    const bucket = s.byWorkspace[s.wsKey];
    if (!bucket) return [];
    return bucket.order
      .map((id) => bucket.canvases[id])
      .filter((d): d is CanvasDoc => !!d)
      .map((d) => ({ id: d.id, name: d.name, active: d.id === s.activeCanvasId }));
  },

  switchCanvas: (id) =>
    set((s) => {
      if (id === s.activeCanvasId) return {};
      const byWorkspace = snapshotByWorkspace(s);
      const bucket = byWorkspace[s.wsKey];
      const doc = bucket?.canvases[id];
      if (!bucket || !doc) return {};
      return {
        byWorkspace: { ...byWorkspace, [s.wsKey]: { ...bucket, activeId: id } },
        activeCanvasId: id,
        ...workingCopy(doc),
        ...ephemeral(),
      };
    }),

  newCanvas: (name) => {
    const id = newCanvasId();
    set((s) => {
      const byWorkspace = snapshotByWorkspace(s);
      const bucket = byWorkspace[s.wsKey] ?? defaultBucket();
      const n = name?.trim() || `Canvas ${bucket.order.length + 1}`;
      const doc: CanvasDoc = { ...emptyCanvas(n), id };
      return {
        byWorkspace: {
          ...byWorkspace,
          [s.wsKey]: {
            order: [...bucket.order, id],
            activeId: id,
            canvases: { ...bucket.canvases, [id]: doc },
          },
        },
        activeCanvasId: id,
        ...workingCopy(doc),
        ...ephemeral(),
      };
    });
    return id;
  },

  renameCanvas: (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    set((s) => {
      const byWorkspace = snapshotByWorkspace(s);
      const bucket = byWorkspace[s.wsKey];
      const doc = bucket?.canvases[id];
      if (!bucket || !doc) return {};
      return {
        byWorkspace: {
          ...byWorkspace,
          [s.wsKey]: { ...bucket, canvases: { ...bucket.canvases, [id]: { ...doc, name: trimmed } } },
        },
      };
    });
  },

  deleteCanvas: (id) => {
    const s = get();
    const bucket = s.byWorkspace[s.wsKey];
    if (!bucket || bucket.order.length <= 1 || !bucket.canvases[id]) return [];
    // The panels to close = members of the deleted canvas (its placed tab ids,
    // expanding any groups). Read from the live working copy when it's the open
    // canvas, else from the snapshot.
    const doc = id === s.activeCanvasId ? activeDoc(s) : bucket.canvases[id];
    const memberTabIds = new Set<string>();
    for (const key of Object.keys(doc.placements)) {
      const grp = doc.groups.find((g) => g.id === key);
      if (grp) for (const t of grp.tabIds) memberTabIds.add(t);
      else memberTabIds.add(key);
    }
    set((cur) => {
      const byWorkspace = snapshotByWorkspace(cur);
      const b = byWorkspace[cur.wsKey];
      if (!b) return {};
      const order = b.order.filter((c) => c !== id);
      const canvases = { ...b.canvases };
      delete canvases[id];
      const nextActive = id === cur.activeCanvasId ? order[0] : cur.activeCanvasId;
      const activeDocNext = canvases[nextActive];
      const base: Partial<CanvasState> = {
        byWorkspace: { ...byWorkspace, [cur.wsKey]: { ...b, order, activeId: nextActive, canvases } },
        activeCanvasId: nextActive,
      };
      // Opening a sibling? Load its working copy + reset ephemeral.
      if (id === cur.activeCanvasId && activeDocNext) {
        return { ...base, ...workingCopy(activeDocNext), ...ephemeral() };
      }
      return base;
    });
    return [...memberTabIds];
  },
}));

/**
 * Re-home the working copy when the active workspace changes: snapshot the open
 * canvas, seed/open the new workspace's active canvas, reset ephemeral selection.
 * Gate on the id so unrelated deck writes (pane focus, layout) don't churn.
 */
let lastWsId: WorkspaceId | null | undefined = useWorkspaceDeckStore.getState().activeWorkspaceId;
useWorkspaceDeckStore.subscribe((state) => {
  const id = state.activeWorkspaceId;
  if (id === lastWsId) return;
  lastWsId = id;
  const nextKey = wsKeyOf(id);
  useCanvasStore.setState((s) => {
    if (nextKey === s.wsKey) return {};
    const snapped = snapshotByWorkspace(s);
    const { byWorkspace, bucket } = seedBucket(snapped, nextKey);
    const doc = bucket.canvases[bucket.activeId];
    return {
      byWorkspace,
      wsKey: nextKey,
      activeCanvasId: bucket.activeId,
      ...workingCopy(doc),
      ...ephemeral(),
    };
  });
  // Reconcile the freshly-opened canvas with the current tab set.
  useCanvasStore.getState().syncPlacements(useTabsStore.getState().tabs.map((t) => t.id));
});

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
 * Persist the per-workspace canvases so arrangements survive reloads (and, for
 * tabs the session restores with the same id, restarts). Microtask-debounced so
 * a drag (many `set`s) writes once. Placements/edges are keyed by tab id; on
 * restart, tabs the session doesn't restore are pruned by `syncPlacements`, so a
 * stale entry never breaks the canvas.
 */
let saveQueued = false;
useCanvasStore.subscribe(() => {
  if (typeof localStorage === 'undefined' || saveQueued) return;
  saveQueued = true;
  queueMicrotask(() => {
    saveQueued = false;
    try {
      const byWorkspace = snapshotByWorkspace(useCanvasStore.getState());
      localStorage.setItem(PERSIST_KEY, JSON.stringify({ byWorkspace }));
    } catch {
      // Ignore quota / serialization failures — persistence is best-effort.
    }
  });
});
