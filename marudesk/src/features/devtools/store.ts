import { create } from 'zustand';
import { useTabsStore } from '../tabs/store';
import { useGridStore } from '../tabs/grid';
import { useSettingsStore } from '../settings/store';
import { useWebPageStore } from '../browser/store';
import { toast } from '../../lib/toast';
import { toMessage } from '../../lib/toMessage';
import { cdpSend, cdpTry } from './cdp';
import { buildCapture } from './capture';
import { computeBlockEdit, rebuildStyleText, resolveStyleSheetSource } from './css-source';
import {
  NODE_TYPE,
  type BoxModel,
  type CdpCookie,
  type CdpNode,
  type ComputedStyleProperty,
  type ConsoleEntry,
  type ConsoleKind,
  type CssStyle,
  type NetworkEntry,
  type NodeId,
  type RemoteObject,
  type RuleMatch,
  type StyleSheetHeader,
} from './types';
import type { PatchOp, PatchPreview } from '../../../shared/patch';

/**
 * The custom DevTools session store. One dock, bound to the active web tab; it
 * owns (1) the dock UI (open/side/size/panel), (2) the CDP session machine
 * idle→attaching→attached→detached, and (3) a slice per panel (Elements DOM
 * tree + styles, Console stream, Network table). Events arrive coalesced over
 * `devtools:cdp-event` and are routed here by `ingestBatch`; a `devtools:detached`
 * resets the machine (see useDevtoolsEvents).
 *
 * The dock tracks the active tab: switching to a different web tab rebinds the
 * session (`rebind`), switching to a feature tab unmounts the dock (it lives in
 * the browser stage) while the toggle stays "on" for the next web tab.
 */

export type DockSide = 'right' | 'bottom';
export type DevtoolsPanel =
  | 'elements'
  | 'console'
  | 'network'
  | 'application'
  | 'rendering';
type Session = 'idle' | 'attaching' | 'attached' | 'detached';

/** Emulated `prefers-color-scheme` (Emulation.setEmulatedMedia features). */
export type ColorScheme = 'no-override' | 'light' | 'dark';
/** Vision-deficiency presets (Emulation.setEmulatedVisionDeficiency `type`). */
export type VisionDeficiency =
  | 'none'
  | 'blurredVision'
  | 'protanopia'
  | 'deuteranopia'
  | 'tritanopia'
  | 'achromatopsia';

/**
 * Rendering-panel toggles (P6). All sticky preferences re-applied on (re)attach
 * — the page loses them on detach/navigation. The Overlay flags are booleans;
 * the Emulation fields drive setEmulatedMedia / setEmulatedVisionDeficiency.
 */
export type RenderingState = {
  paintRects: boolean;
  layoutShiftRegions: boolean;
  fpsCounter: boolean;
  scrollBottleneck: boolean;
  webVitals: boolean;
  colorScheme: ColorScheme;
  reducedMotion: boolean;
  printMedia: boolean;
  visionDeficiency: VisionDeficiency;
};

const DEFAULT_RENDERING: RenderingState = {
  paintRects: false,
  layoutShiftRegions: false,
  fpsCounter: false,
  scrollBottleneck: false,
  webVitals: false,
  colorScheme: 'no-override',
  reducedMotion: false,
  printMedia: false,
  visionDeficiency: 'none',
};

/** True if any rendering override is active (so it's worth re-applying on attach). */
function hasRenderingOverrides(r: RenderingState): boolean {
  return (
    r.paintRects ||
    r.layoutShiftRegions ||
    r.fpsCounter ||
    r.scrollBottleneck ||
    r.webVitals ||
    r.colorScheme !== 'no-override' ||
    r.reducedMotion ||
    r.printMedia ||
    r.visionDeficiency !== 'none'
  );
}

/** Network throttling presets (Network.emulateNetworkConditions params). */
export type ThrottlePreset = 'online' | 'fast3g' | 'slow3g' | 'offline';
const THROTTLE_CONDITIONS: Record<
  Exclude<ThrottlePreset, 'online'>,
  { offline: boolean; latency: number; downloadThroughput: number; uploadThroughput: number }
> = {
  // Bandwidth in bytes/s, latency in ms — Chrome DevTools' canonical presets.
  fast3g: {
    offline: false,
    latency: 562.5,
    downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
  },
  slow3g: {
    offline: false,
    latency: 2000,
    downloadThroughput: (500 * 1024) / 8,
    uploadThroughput: (500 * 1024) / 8,
  },
  offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
};

type Styles = {
  inline?: CssStyle;
  matched: RuleMatch[];
  computed: ComputedStyleProperty[];
};

/**
 * A workspace source patch a live CSS edit mapped to (§9-B), validated by
 * `patch:preview` and awaiting the user's "Save to source". Null when the last
 * edit was live-only (no mapping / not a workspace file).
 */
type PendingSourcePatch = {
  path: string;
  /** 1-based start line of the matched block, from the preview, for display. */
  startLine: number;
  op: PatchOp;
};

const DEFAULT_SIZE: Record<DockSide, number> = { right: 480, bottom: 320 };
const MIN_SIZE = 220;
const MAX_CONSOLE = 1500;
const MAX_NETWORK = 1500;

// CDP overlay box-model colours (content / padding / border / margin).
const rgba = (r: number, g: number, b: number, a: number) => ({ r, g, b, a });
const HIGHLIGHT_CONFIG = {
  showInfo: true,
  showStyles: false,
  contentColor: rgba(111, 168, 220, 0.45),
  paddingColor: rgba(147, 196, 125, 0.55),
  borderColor: rgba(255, 229, 153, 0.65),
  marginColor: rgba(246, 178, 107, 0.55),
};

type DevtoolsState = {
  // dock UI
  open: boolean;
  side: DockSide;
  size: number;
  panel: DevtoolsPanel;
  // True when this store instance backs the pop-out DevtoolsWindow (its own
  // renderer) rather than the in-page dock. Drives full-bleed layout and hides
  // the host-only "Add to AI context" capture (the composer lives in the main
  // window — cross-window capture is out of scope).
  windowMode: boolean;
  // session
  tabId: string | null;
  session: Session;
  detachReason: string | null;
  enabled: Set<string>;
  dropped: number;
  // Monotonic session generation. Bumped on every transition (open/close/rebind)
  // so an async flow whose await straddled a newer transition can detect it and
  // bail — prevents a rapid A→B→A switch from leaving a zombie debugger.
  epoch: number;
  // elements
  nodes: Map<NodeId, CdpNode>;
  childIds: Map<NodeId, NodeId[]>;
  documentId: NodeId | null;
  selectedId: NodeId | null;
  expanded: Set<NodeId>;
  styles: Styles | null;
  stylesLoading: boolean;
  picking: boolean;
  // Forced pseudo-classes on the selected node (CSS.forcePseudoState). Per-node:
  // cleared when the selection changes (CDP keeps the forcing on the old node, so
  // we also clear it there on switch).
  forcedStates: Set<string>;
  // Box model of the selected node (DOM.getBoxModel), for the diagram. Null until
  // a node with layout is selected.
  boxModel: BoxModel | null;
  // DOM search session (DOM.performSearch): the search id + the resolved result
  // nodeIds + the cursor into them. searchId is needed to discard on the page.
  searchId: string | null;
  searchResults: NodeId[];
  searchIndex: number;
  searchCount: number;
  // styleSheetId → header, for mapping an edited rule back to source (§9-B).
  styleSheets: Map<string, StyleSheetHeader>;
  pendingPatch: PendingSourcePatch | null;
  // console
  console: ConsoleEntry[];
  // When true, a main-frame navigation keeps the existing console entries
  // (DevTools' "Preserve log") — `_handleNavigated` reads this. Sticky across
  // navigations; survives freshSlices (a UI preference, not per-page state).
  preserveLog: boolean;
  // network
  network: NetworkEntry[];
  // Sticky network conditions (DevTools' Disable cache / throttling). Re-applied
  // every time the Network domain is (re)enabled — they reset on navigation.
  // Survive freshSlices (preferences, not per-page state).
  cacheDisabled: boolean;
  throttle: ThrottlePreset;
  // application (storage) — resolved from the bound tab's URL on panel open.
  appOrigin: string | null;
  localStorageItems: [string, string][];
  sessionStorageItems: [string, string][];
  cookies: CdpCookie[];
  appLoading: boolean;
  // rendering panel toggles — sticky preferences, re-applied on (re)attach.
  rendering: RenderingState;
};

type DevtoolsActions = {
  toggle: () => void;
  reconnect: () => void;
  close: () => void;
  popOut: () => void;
  setWindowMode: (on: boolean) => void;
  setPanel: (panel: DevtoolsPanel) => void;
  setSide: (side: DockSide) => void;
  setSize: (size: number) => void;
  rebindToActive: (tabId: string | null) => void;
  // elements
  selectNode: (id: NodeId) => Promise<void>;
  toggleExpand: (id: NodeId) => void;
  refreshDocument: () => Promise<void>;
  highlightNode: (id: NodeId) => void;
  hideHighlight: () => void;
  startPick: () => Promise<void>;
  stopPick: () => Promise<void>;
  inspectAt: (tabId: string, x: number, y: number) => Promise<void>;
  captureSelected: () => Promise<void>;
  toggleForcedState: (pseudoClass: string) => Promise<void>;
  searchDom: (query: string) => Promise<void>;
  stepSearch: (delta: number) => Promise<void>;
  clearSearch: () => void;
  // live edit + source-patch hook (§9-B)
  editStyleProperty: (style: CssStyle, propIndex: number, newValue: string) => Promise<void>;
  setAttribute: (nodeId: NodeId, name: string, value: string) => Promise<void>;
  applySourcePatch: () => Promise<void>;
  dismissSourcePatch: () => void;
  // console
  evaluate: (expression: string) => Promise<void>;
  clearConsole: () => void;
  setPreserveLog: (on: boolean) => void;
  getProperties: (
    objectId: string,
  ) => Promise<{ name: string; value: RemoteObject }[]>;
  // network
  clearNetwork: () => void;
  getResponseBody: (
    requestId: string,
  ) => Promise<{ body: string; base64Encoded: boolean } | null>;
  setCacheDisabled: (on: boolean) => void;
  setThrottle: (preset: ThrottlePreset) => void;
  /** Push the sticky cache/throttle conditions to the page (on enable / change). */
  _applyNetworkConditions: () => Promise<void>;
  // application (storage)
  refreshApplication: () => Promise<void>;
  removeStorageItem: (isLocalStorage: boolean, key: string) => Promise<void>;
  clearStorage: (isLocalStorage: boolean) => Promise<void>;
  clearSiteData: () => Promise<void>;
  // rendering
  setRendering: (patch: Partial<RenderingState>) => void;
  /** Push all rendering toggles to the page (on change / re-attach). */
  _applyRendering: () => Promise<void>;
  // event ingestion
  ingestBatch: (
    items: { method: string; params: unknown }[],
    dropped?: number,
  ) => void;
  handleDetached: (tabId: string, reason: string) => void;
  // internal helpers (prefixed _)
  _openFor: (tabId: string, side: DockSide) => Promise<void>;
  _ensureDomains: (domains: string[]) => Promise<void>;
  _enablePanel: (panel: DevtoolsPanel) => Promise<void>;
  _handleNavigated: () => void;
  _pushConsole: (entry: Omit<ConsoleEntry, 'id' | 'timestamp'> & { timestamp?: number }) => void;
  _finishPick: (backendNodeId: number) => Promise<void>;
  _revealAndSelect: (nodeId: NodeId) => Promise<void>;
  _offerSourcePatch: (
    styleSheetId: string,
    oldBlock: string,
    newBlock: string,
  ) => Promise<void>;
};

function freshSlices(): Pick<
  DevtoolsState,
  | 'nodes'
  | 'childIds'
  | 'documentId'
  | 'selectedId'
  | 'expanded'
  | 'styles'
  | 'stylesLoading'
  | 'picking'
  | 'forcedStates'
  | 'boxModel'
  | 'searchId'
  | 'searchResults'
  | 'searchIndex'
  | 'searchCount'
  | 'styleSheets'
  | 'pendingPatch'
  | 'console'
  | 'network'
  | 'appOrigin'
  | 'localStorageItems'
  | 'sessionStorageItems'
  | 'cookies'
  | 'appLoading'
  | 'dropped'
> {
  return {
    nodes: new Map(),
    childIds: new Map(),
    documentId: null,
    selectedId: null,
    expanded: new Set(),
    styles: null,
    stylesLoading: false,
    picking: false,
    forcedStates: new Set(),
    boxModel: null,
    searchId: null,
    searchResults: [],
    searchIndex: 0,
    searchCount: 0,
    styleSheets: new Map(),
    pendingPatch: null,
    console: [],
    network: [],
    appOrigin: null,
    localStorageItems: [],
    sessionStorageItems: [],
    cookies: [],
    appLoading: false,
    dropped: 0,
  };
}

/* ── DOM indexing helpers (operate on mutable containers; caller clones) ── */

function indexNode(
  node: CdpNode,
  nodes: Map<NodeId, CdpNode>,
  childIds: Map<NodeId, NodeId[]>,
): void {
  const { children, ...flat } = node;
  nodes.set(node.nodeId, flat);
  if (children) {
    childIds.set(
      node.nodeId,
      children.map((c) => c.nodeId),
    );
    for (const c of children) indexNode(c, nodes, childIds);
  } else if (node.childNodeCount === 0) {
    childIds.set(node.nodeId, []);
  }
}

function setAttr(attrs: string[] | undefined, name: string, value: string): string[] {
  const next = attrs ? [...attrs] : [];
  for (let i = 0; i < next.length; i += 2) {
    if (next[i] === name) {
      next[i + 1] = value;
      return next;
    }
  }
  next.push(name, value);
  return next;
}

function removeAttr(attrs: string[] | undefined, name: string): string[] {
  const next: string[] = [];
  if (!attrs) return next;
  for (let i = 0; i < attrs.length; i += 2) {
    if (attrs[i] !== name) next.push(attrs[i], attrs[i + 1]);
  }
  return next;
}

function consoleKindFromApi(type: string): ConsoleKind {
  switch (type) {
    case 'error':
    case 'assert':
      return 'error';
    case 'warning':
      return 'warning';
    case 'debug':
      return 'debug';
    case 'info':
      return 'info';
    default:
      return 'log';
  }
}

function consoleKindFromLog(level: string): ConsoleKind {
  switch (level) {
    case 'error':
      return 'error';
    case 'warning':
      return 'warning';
    case 'verbose':
      return 'debug';
    default:
      return 'info';
  }
}

let entrySeq = 0;
function entryId(): string {
  return `c${++entrySeq}`;
}

export const useDevtoolsStore = create<DevtoolsState & DevtoolsActions>(
  (set, get) => ({
    open: false,
    side: 'right',
    size: 0,
    panel: 'elements',
    windowMode: false,
    preserveLog: false,
    cacheDisabled: false,
    throttle: 'online',
    rendering: DEFAULT_RENDERING,
    tabId: null,
    session: 'idle',
    detachReason: null,
    enabled: new Set(),
    epoch: 0,
    ...freshSlices(),

    /* ── dock lifecycle ──────────────────────────────────────────────── */

    toggle: () => {
      if (useGridStore.getState().layout !== null) {
        toast({
          title: 'Exit the grid to use DevTools',
          description: 'DevTools attaches to a single page at a time.',
          variant: 'warning',
        });
        return;
      }
      const tabs = useTabsStore.getState();
      const active = tabs.tabs.find((t) => t.id === tabs.activeTabId);
      if (!active || active.kind !== 'web') return;
      const dock = useSettingsStore.getState().settings.devtools.defaultDock;
      if (dock === 'chrome') {
        void window.marudesk.invoke('devtools:open-chrome', { tabId: active.id });
        return;
      }
      const s = get();
      if (s.open && s.tabId === active.id && s.session !== 'detached') {
        s.close();
      } else {
        void s._openFor(active.id, dock);
      }
    },

    reconnect: () => {
      const s = get();
      // In the pop-out window there's no tab strip — reconnect to the bound tab.
      if (s.windowMode) {
        if (s.tabId) void s._openFor(s.tabId, s.side);
        return;
      }
      const tabs = useTabsStore.getState();
      const active = tabs.tabs.find((t) => t.id === tabs.activeTabId);
      if (active?.kind === 'web') void s._openFor(active.id, s.side);
    },

    _openFor: async (tabId, side) => {
      const prev = get().tabId;
      const epoch = get().epoch + 1;
      set({
        open: true,
        side,
        size: get().size >= MIN_SIZE ? get().size : DEFAULT_SIZE[side],
        tabId,
        session: 'attaching',
        detachReason: null,
        enabled: new Set(),
        epoch,
        ...freshSlices(),
      });
      // Defensive single-client: if a different tab was still bound (a rebind
      // caught mid-flight), detach it before attaching the new one.
      if (prev && prev !== tabId) {
        await window.marudesk.invoke('devtools:close', { tabId: prev });
        if (get().epoch !== epoch) return;
      }
      const ok = await window.marudesk.invoke('devtools:open', { tabId });
      if (get().epoch !== epoch) return; // a newer transition superseded us
      if (!ok) {
        set({ session: 'idle', open: false });
        return;
      }
      set({ session: 'attached' });
      // Page → main-frame nav re-enable (§4/§11.3); Runtime/Log → capture
      // console from the start.
      await get()._ensureDomains(['Page', 'Runtime', 'Log']);
      if (get().epoch !== epoch) return;
      await get()._enablePanel(get().panel);
      if (get().epoch !== epoch) return;
      // Re-apply sticky rendering overrides — they reset on (re)attach.
      if (hasRenderingOverrides(get().rendering)) await get()._applyRendering();
    },

    close: () => {
      const tabId = get().tabId;
      if (tabId) {
        void cdpTry(tabId, 'Overlay.hideHighlight');
        void window.marudesk.invoke('devtools:close', { tabId });
      }
      set({
        open: false,
        tabId: null,
        session: 'idle',
        detachReason: null,
        enabled: new Set(),
        epoch: get().epoch + 1,
        ...freshSlices(),
      });
    },

    popOut: () => {
      const tabId = get().tabId;
      if (!tabId) return;
      // Single CDP client per page: detach the in-dock session cleanly first
      // (close() bumps the epoch + resets the machine), then ask main to open
      // the popup, which re-attaches in its own renderer.
      get().close();
      void window.marudesk.invoke('devtools:popout-open', { tabId });
    },

    setWindowMode: (on) => set({ windowMode: on }),

    setPanel: (panel) => {
      if (get().panel === panel) return;
      set({ panel });
      if (get().session === 'attached') void get()._enablePanel(panel);
    },

    setSide: (side) => set({ side, size: DEFAULT_SIZE[side] }),

    setSize: (size) => set({ size: Math.max(MIN_SIZE, Math.round(size)) }),

    rebindToActive: (tabId) => {
      const s = get();
      if (!s.open) return;
      if (tabId === s.tabId) return;
      // Active tab left the web kind (feature tab) — the dock unmounts with the
      // browser stage; keep the session so returning to this tab is instant.
      if (tabId === null) return;
      const old = s.tabId;
      const epoch = s.epoch + 1;
      set({
        tabId,
        session: 'attaching',
        detachReason: null,
        enabled: new Set(),
        epoch,
        ...freshSlices(),
      });
      void (async () => {
        // Detach the previous tab BEFORE attaching the new one, so two opposing
        // IPCs can't reorder into a zombie debugger (single client per page).
        if (old) await window.marudesk.invoke('devtools:close', { tabId: old });
        if (get().epoch !== epoch) return;
        const ok = await window.marudesk.invoke('devtools:open', { tabId });
        if (get().epoch !== epoch) return;
        if (!ok) {
          set({ session: 'idle' });
          return;
        }
        set({ session: 'attached' });
        await get()._ensureDomains(['Page', 'Runtime', 'Log']);
        if (get().epoch !== epoch) return;
        await get()._enablePanel(get().panel);
        if (get().epoch !== epoch) return;
        if (hasRenderingOverrides(get().rendering)) await get()._applyRendering();
      })();
    },

    /* ── domain enable ───────────────────────────────────────────────── */

    _ensureDomains: async (domains) => {
      const tabId = get().tabId;
      if (!tabId) return;
      const enabled = get().enabled;
      const toEnable = domains.filter((d) => !enabled.has(d));
      if (toEnable.length === 0) return;
      const next = new Set(enabled);
      for (const d of toEnable) next.add(d);
      set({ enabled: next }); // optimistic — re-enable is harmless if it races
      await Promise.all(toEnable.map((d) => cdpTry(tabId, `${d}.enable`)));
    },

    _enablePanel: async (panel) => {
      if (panel === 'elements') {
        await get()._ensureDomains(['DOM', 'CSS', 'Overlay']);
        if (get().documentId === null) await get().refreshDocument();
      } else if (panel === 'console') {
        await get()._ensureDomains(['Runtime', 'Log']);
      } else if (panel === 'network') {
        // Lazy: Network is the flood-prone domain (main already drops
        // dataReceived). Only enabled when the user opens this panel.
        await get()._ensureDomains(['Network']);
        // Re-apply sticky cache/throttle — they reset whenever Network is
        // (re)enabled (fresh attach or post-navigation re-enable).
        await get()._applyNetworkConditions();
      } else if (panel === 'application') {
        // DOMStorage for live storage events; Network is needed for getCookies.
        await get()._ensureDomains(['DOMStorage', 'Network']);
        await get().refreshApplication();
      }
      // 'rendering' needs no panel-specific enable — its toggles target the
      // already-enabled Overlay domain + the stateless Emulation setters.
    },

    _handleNavigated: () => {
      // Main-frame navigation: the debugger survives, but the document, nodeIds,
      // and execution contexts reset (and Chromium may drop domain enablement).
      // Clear stale per-page state and re-enable the active domains against the
      // new document. Console is kept iff "Preserve log" is on (DevTools' toggle);
      // everything else (DOM/styles/network) is always reset — those nodeIds /
      // requestIds are meaningless on the new document.
      set({
        enabled: new Set(),
        ...(get().preserveLog ? {} : { console: [] }),
        network: [],
        nodes: new Map(),
        childIds: new Map(),
        documentId: null,
        expanded: new Set(),
        selectedId: null,
        styles: null,
        forcedStates: new Set(),
        boxModel: null,
        searchId: null,
        searchResults: [],
        searchIndex: 0,
        searchCount: 0,
        styleSheets: new Map(),
        pendingPatch: null,
        appOrigin: null,
        localStorageItems: [],
        sessionStorageItems: [],
        cookies: [],
      });
      const epoch = get().epoch;
      void (async () => {
        await get()._ensureDomains(['Page', 'Runtime', 'Log']);
        if (get().epoch !== epoch) return;
        await get()._enablePanel(get().panel);
        if (get().epoch !== epoch) return;
        // Navigation clears emulation/overlay overrides — re-apply the sticky ones.
        if (hasRenderingOverrides(get().rendering)) await get()._applyRendering();
      })();
    },

    /* ── elements ────────────────────────────────────────────────────── */

    refreshDocument: async () => {
      const tabId = get().tabId;
      if (!tabId) return;
      const res = await cdpTry<{ root: CdpNode }>(tabId, 'DOM.getDocument', {
        depth: 3,
      });
      if (!res?.root || get().tabId !== tabId) return;
      const nodes = new Map<NodeId, CdpNode>();
      const childIds = new Map<NodeId, NodeId[]>();
      indexNode(res.root, nodes, childIds);
      const expanded = new Set<NodeId>([res.root.nodeId]);
      const docKids = childIds.get(res.root.nodeId) ?? [];
      const html = docKids
        .map((id) => nodes.get(id))
        .find((n) => n?.nodeType === NODE_TYPE.ELEMENT);
      if (html) {
        expanded.add(html.nodeId);
        const body = (childIds.get(html.nodeId) ?? [])
          .map((id) => nodes.get(id))
          .find((n) => n?.nodeName === 'BODY');
        if (body) expanded.add(body.nodeId);
      }
      set({ nodes, childIds, documentId: res.root.nodeId, expanded });
    },

    toggleExpand: (id) => {
      const expanded = new Set(get().expanded);
      if (expanded.has(id)) {
        expanded.delete(id);
        set({ expanded });
        return;
      }
      expanded.add(id);
      set({ expanded });
      if (!get().childIds.has(id)) {
        const tabId = get().tabId;
        if (tabId) void cdpTry(tabId, 'DOM.requestChildNodes', { nodeId: id, depth: 1 });
      }
    },

    selectNode: async (id) => {
      const prev = get().selectedId;
      const tabId = get().tabId;
      // Forced pseudo-classes are per-node: clear them on the node we're leaving
      // so a stale :hover doesn't linger after the user moves on.
      if (tabId && prev !== null && prev !== id && get().forcedStates.size > 0) {
        void cdpTry(tabId, 'CSS.forcePseudoState', {
          nodeId: prev,
          forcedPseudoClasses: [],
        });
      }
      set({ selectedId: id, styles: null, stylesLoading: true, forcedStates: new Set(), boxModel: null });
      if (!tabId) {
        set({ stylesLoading: false });
        return;
      }
      get().highlightNode(id);
      const [matched, computed, box] = await Promise.all([
        cdpTry<{ inlineStyle?: CssStyle; matchedCSSRules?: RuleMatch[] }>(
          tabId,
          'CSS.getMatchedStylesForNode',
          { nodeId: id },
        ),
        cdpTry<{ computedStyle: ComputedStyleProperty[] }>(
          tabId,
          'CSS.getComputedStyleForNode',
          { nodeId: id },
        ),
        cdpTry<{ model: BoxModel }>(tabId, 'DOM.getBoxModel', { nodeId: id }),
      ]);
      if (get().selectedId !== id) return; // selection moved while awaiting
      set({
        styles: {
          inline: matched?.inlineStyle,
          matched: matched?.matchedCSSRules ?? [],
          computed: computed?.computedStyle ?? [],
        },
        boxModel: box?.model ?? null,
        stylesLoading: false,
      });
    },

    highlightNode: (id) => {
      const tabId = get().tabId;
      if (!tabId) return;
      void cdpTry(tabId, 'Overlay.highlightNode', {
        highlightConfig: HIGHLIGHT_CONFIG,
        nodeId: id,
      });
    },

    hideHighlight: () => {
      const tabId = get().tabId;
      if (!tabId) return;
      void cdpTry(tabId, 'Overlay.hideHighlight');
    },

    startPick: async () => {
      const tabId = get().tabId;
      if (!tabId) return;
      await get()._ensureDomains(['DOM', 'Overlay']);
      set({ picking: true });
      await cdpTry(tabId, 'Overlay.setInspectMode', {
        mode: 'searchForNode',
        highlightConfig: HIGHLIGHT_CONFIG,
      });
    },

    stopPick: async () => {
      const tabId = get().tabId;
      set({ picking: false });
      if (tabId) {
        await cdpTry(tabId, 'Overlay.setInspectMode', {
          mode: 'none',
          highlightConfig: HIGHLIGHT_CONFIG,
        });
      }
    },

    _finishPick: async (backendNodeId) => {
      const tabId = get().tabId;
      set({ picking: false });
      if (!tabId) return;
      await cdpTry(tabId, 'Overlay.setInspectMode', {
        mode: 'none',
        highlightConfig: HIGHLIGHT_CONFIG,
      });
      const res = await cdpTry<{ nodeIds: NodeId[] }>(
        tabId,
        'DOM.pushNodesByBackendIdsToFrontend',
        { backendNodeIds: [backendNodeId] },
      );
      const nodeId = res?.nodeIds?.[0];
      if (nodeId) await get()._revealAndSelect(nodeId);
    },

    inspectAt: async (tabId, x, y) => {
      const dock = useSettingsStore.getState().settings.devtools.defaultDock;
      if (dock === 'chrome') {
        void window.marudesk.invoke('devtools:open-chrome', { tabId });
        return;
      }
      if (useGridStore.getState().layout !== null) {
        toast({ title: 'Exit the grid to use DevTools', variant: 'warning' });
        return;
      }

      // Resolve the node at the click point, then reveal it. getNodeForLocation
      // returns a layout-independent backendNodeId, so once resolved the node
      // stays valid even after the dock reflows the page.
      const resolveAndSelect = async (epoch: number) => {
        const res = await cdpTry<{ backendNodeId: number; nodeId?: NodeId }>(
          tabId,
          'DOM.getNodeForLocation',
          { x, y, includeUserAgentShadowDOM: false },
        );
        if (get().epoch !== epoch || !res) return;
        let nodeId = res.nodeId;
        if (!nodeId && res.backendNodeId) {
          const pushed = await cdpTry<{ nodeIds: NodeId[] }>(
            tabId,
            'DOM.pushNodesByBackendIdsToFrontend',
            { backendNodeIds: [res.backendNodeId] },
          );
          if (get().epoch !== epoch) return;
          nodeId = pushed?.nodeIds?.[0];
        }
        if (nodeId) await get()._revealAndSelect(nodeId);
      };

      if (get().open && get().tabId === tabId && get().session === 'attached') {
        // Dock already open here: the page is already at its docked size, so the
        // right-click coords are correct for the current viewport — resolve now.
        if (get().panel !== 'elements') {
          set({ panel: 'elements' });
          await get()._enablePanel('elements');
        }
        await resolveAndSelect(get().epoch);
        return;
      }

      // Dock was closed: attach and resolve the node WHILE the page is still
      // full-size, THEN reveal the dock (which shrinks the page). Opening first
      // would reflow the page and the cached point would hit the wrong element.
      const epoch = get().epoch + 1;
      set({
        side: dock,
        size: get().size >= MIN_SIZE ? get().size : DEFAULT_SIZE[dock],
        tabId,
        panel: 'elements',
        session: 'attaching',
        detachReason: null,
        enabled: new Set(),
        epoch,
        open: false, // not shown yet — keep the page full-size for the resolve
        ...freshSlices(),
      });
      const ok = await window.marudesk.invoke('devtools:open', { tabId });
      if (get().epoch !== epoch) return;
      if (!ok) {
        set({ session: 'idle' });
        return;
      }
      set({ session: 'attached' });
      await get()._ensureDomains([
        'Page',
        'Runtime',
        'Log',
        'DOM',
        'CSS',
        'Overlay',
      ]);
      if (get().epoch !== epoch) return;
      await get().refreshDocument();
      if (get().epoch !== epoch) return;
      await resolveAndSelect(epoch);
      if (get().epoch !== epoch) return;
      set({ open: true }); // reveal now that the node is resolved
    },

    _revealAndSelect: async (nodeId) => {
      // Expand whatever ancestors are already indexed (best-effort: the chain
      // is filled in lazily by setChildNodes events, which may still be in
      // flight — selection + styles work regardless).
      const expanded = new Set(get().expanded);
      const seen = new Set<NodeId>();
      let cur = get().nodes.get(nodeId);
      while (cur?.parentId && !seen.has(cur.parentId)) {
        seen.add(cur.parentId);
        expanded.add(cur.parentId);
        cur = get().nodes.get(cur.parentId);
      }
      set({ expanded });
      await get().selectNode(nodeId);
    },

    captureSelected: async () => {
      const { tabId, selectedId, nodes, styles } = get();
      const node = selectedId !== null ? nodes.get(selectedId) : undefined;
      if (!tabId || selectedId === null || !node || node.nodeType !== NODE_TYPE.ELEMENT) {
        toast({ title: 'Select an element first', variant: 'warning' });
        return;
      }
      // Reuse the computed style the Elements panel already loaded for the
      // selection (no extra round-trip); buildCapture only fetches outerHTML +
      // box model. url comes from the bound web tab's address bar.
      const url = useWebPageStore.getState().currentUrl;
      const capture = await buildCapture(
        tabId,
        selectedId,
        node,
        nodes,
        styles?.computed ?? [],
        url,
      );
      if (get().tabId !== tabId) return; // navigated / rebound while assembling
      useWebPageStore.getState().addCapture(capture);
      toast({
        title: 'Added to context',
        description: capture.selector || capture.tagName,
        variant: 'success',
      });
    },

    toggleForcedState: async (pseudoClass) => {
      const tabId = get().tabId;
      const nodeId = get().selectedId;
      if (!tabId || nodeId === null) return;
      const next = new Set(get().forcedStates);
      if (next.has(pseudoClass)) next.delete(pseudoClass);
      else next.add(pseudoClass);
      set({ forcedStates: next });
      await cdpTry(tabId, 'CSS.forcePseudoState', {
        nodeId,
        forcedPseudoClasses: [...next],
      });
      if (get().selectedId !== nodeId) return; // moved while awaiting
      // Re-read styles so rules gated on the now-forced state appear/disappear.
      await get().selectNode(nodeId);
    },

    searchDom: async (query) => {
      const tabId = get().tabId;
      if (!tabId) return;
      get().clearSearch();
      const q = query.trim();
      if (!q) return;
      await get()._ensureDomains(['DOM']);
      const res = await cdpTry<{ searchId: string; resultCount: number }>(
        tabId,
        'DOM.performSearch',
        { query: q, includeUserAgentShadowDOM: false },
      );
      if (!res || get().tabId !== tabId) {
        if (res) void cdpTry(tabId, 'DOM.discardSearchResults', { searchId: res.searchId });
        return;
      }
      if (res.resultCount === 0) {
        set({ searchId: res.searchId, searchResults: [], searchIndex: 0, searchCount: 0 });
        return;
      }
      const got = await cdpTry<{ nodeIds: NodeId[] }>(tabId, 'DOM.getSearchResults', {
        searchId: res.searchId,
        fromIndex: 0,
        toIndex: res.resultCount,
      });
      if (get().tabId !== tabId) {
        void cdpTry(tabId, 'DOM.discardSearchResults', { searchId: res.searchId });
        return;
      }
      const nodeIds = got?.nodeIds ?? [];
      set({
        searchId: res.searchId,
        searchResults: nodeIds,
        searchCount: res.resultCount,
        searchIndex: 0,
      });
      if (nodeIds[0] !== undefined) await get()._revealAndSelect(nodeIds[0]);
    },

    stepSearch: async (delta) => {
      const { searchResults, searchIndex } = get();
      if (searchResults.length === 0) return;
      const n = searchResults.length;
      const next = ((searchIndex + delta) % n + n) % n;
      set({ searchIndex: next });
      const nodeId = searchResults[next];
      if (nodeId !== undefined) await get()._revealAndSelect(nodeId);
    },

    clearSearch: () => {
      const tabId = get().tabId;
      const searchId = get().searchId;
      if (tabId && searchId) {
        void cdpTry(tabId, 'DOM.discardSearchResults', { searchId });
      }
      set({ searchId: null, searchResults: [], searchIndex: 0, searchCount: 0 });
    },

    /* ── live edit (CSS / attributes) + source-patch hook ─────────────── */

    editStyleProperty: async (style, propIndex, newValue) => {
      const tabId = get().tabId;
      const selId = get().selectedId;
      if (!tabId || selId === null) return;
      const styleSheetId = style.styleSheetId;
      const blockRange = style.range;
      if (!styleSheetId || !blockRange) {
        toast({ title: 'This rule is read-only', variant: 'warning' });
        return;
      }
      const prop = style.cssProperties[propIndex];
      if (!prop || !prop.name) return;
      const value = newValue.trim().replace(/;+$/, '').trim();
      if (!value || value === prop.value) return; // empty / no-op

      // Ground truth = the served stylesheet text: enables a precise,
      // formatting-preserving splice used for BOTH the live `setStyleTexts` and
      // (hook B) the source patch's oldString. Falls back to a deterministic
      // block rebuild when ranges are unavailable.
      const sheet = await cdpTry<{ text: string }>(tabId, 'CSS.getStyleSheetText', {
        styleSheetId,
      });
      if (get().selectedId !== selId) return;
      const edit =
        sheet?.text !== undefined
          ? computeBlockEdit(sheet.text, blockRange, prop, value)
          : null;
      const newBlockText = edit?.newBlock ?? rebuildStyleText(style, propIndex, value);

      try {
        await cdpSend(tabId, 'CSS.setStyleTexts', {
          edits: [{ styleSheetId, range: blockRange, text: newBlockText }],
        });
      } catch (err) {
        toast({ title: 'Edit rejected', description: toMessage(err), variant: 'error' });
        return;
      }
      // The edit landed on the captured tab, but a rebind/nav during the
      // round-trip would make selId a stale nodeId on the new document — don't
      // refresh/offer against it.
      if (get().tabId !== tabId || get().selectedId !== selId) return;
      await get().selectNode(selId); // ranges/values shift after an edit
      // Hook B: map the edit to a workspace file, or clear to live-only. Note
      // `oldBlock` is the served text BEFORE this edit, which equals the file
      // only for the first edit of a block; a 2nd edit before "Save to source"
      // won't match disk and degrades to live-only (§19) — save between edits.
      if (edit) void get()._offerSourcePatch(styleSheetId, edit.oldBlock, edit.newBlock);
      else set({ pendingPatch: null });
    },

    setAttribute: async (nodeId, name, value) => {
      const tabId = get().tabId;
      if (!tabId) return;
      try {
        // The resulting DOM.attributeModified event updates the tree (ingestBatch).
        await cdpSend(tabId, 'DOM.setAttributeValue', { nodeId, name, value });
      } catch (err) {
        toast({
          title: 'Attribute edit rejected',
          description: toMessage(err),
          variant: 'error',
        });
      }
    },

    _offerSourcePatch: async (styleSheetId, oldBlock, newBlock) => {
      const tabId = get().tabId;
      const selId = get().selectedId;
      const header = get().styleSheets.get(styleSheetId);
      if (!header) {
        set({ pendingPatch: null });
        return;
      }
      let docOrigin = '';
      try {
        docOrigin = new URL(useWebPageStore.getState().currentUrl).origin;
      } catch {
        /* no usable origin → no source mapping */
      }
      const rel = resolveStyleSheetSource(header, docOrigin);
      if (!rel) {
        set({ pendingPatch: null });
        return;
      }
      // Delegate the real feasibility check to patch:preview — it resolves the
      // path fs-safely, confirms the file exists, and that oldBlock matches
      // uniquely. Any failure → live-only (no offer).
      const op: PatchOp = { path: rel, oldString: oldBlock, newString: newBlock };
      let preview: PatchPreview;
      try {
        preview = await window.marudesk.invoke('patch:preview', [op]);
      } catch {
        set({ pendingPatch: null });
        return;
      }
      // tab/selection moved while previewing — drop a now-irrelevant offer
      // (guards against a cross-tab "Save to source" after a rebind).
      if (get().tabId !== tabId || get().selectedId !== selId) return;
      const first = preview.ops[0];
      if (preview.hasErrors || !first || first.kind !== 'edit') {
        set({ pendingPatch: null });
        return;
      }
      set({ pendingPatch: { path: rel, startLine: first.startLine, op } });
    },

    applySourcePatch: async () => {
      const pending = get().pendingPatch;
      if (!pending) return;
      try {
        const res = await window.marudesk.invoke('patch:apply', [pending.op]);
        if (res.ok) {
          toast({ title: 'Saved to source', description: pending.path, variant: 'success' });
        } else {
          toast({
            title: 'Save failed',
            description: res.errors[0]?.reason ?? 'unknown error',
            variant: 'error',
          });
        }
      } catch (err) {
        toast({ title: 'Save failed', description: toMessage(err), variant: 'error' });
      }
      set({ pendingPatch: null });
    },

    dismissSourcePatch: () => set({ pendingPatch: null }),

    /* ── console ─────────────────────────────────────────────────────── */

    _pushConsole: (entry) => {
      const e: ConsoleEntry = {
        id: entryId(),
        timestamp: entry.timestamp ?? Date.now(),
        kind: entry.kind,
        args: entry.args,
        text: entry.text,
        stackTrace: entry.stackTrace,
        url: entry.url,
        lineNumber: entry.lineNumber,
      };
      const next = [...get().console, e];
      if (next.length > MAX_CONSOLE) next.splice(0, next.length - MAX_CONSOLE);
      set({ console: next });
    },

    evaluate: async (expression) => {
      const tabId = get().tabId;
      if (!tabId || !expression.trim()) return;
      await get()._ensureDomains(['Runtime']);
      get()._pushConsole({ kind: 'command', args: [], text: expression });
      try {
        const r = await cdpSend<{
          result: RemoteObject;
          exceptionDetails?: {
            text: string;
            exception?: RemoteObject;
            lineNumber?: number;
          };
        }>(tabId, 'Runtime.evaluate', {
          expression,
          objectGroup: 'console',
          includeCommandLineAPI: true,
          generatePreview: true,
          returnByValue: false,
          userGesture: true,
          awaitPromise: true,
          replMode: true,
        });
        if (r.exceptionDetails) {
          const ex = r.exceptionDetails.exception;
          get()._pushConsole({
            kind: 'exception',
            args: ex ? [ex] : [],
            text: ex ? undefined : r.exceptionDetails.text,
          });
        } else {
          get()._pushConsole({ kind: 'result', args: [r.result] });
        }
      } catch (err) {
        get()._pushConsole({
          kind: 'error',
          args: [],
          text: err instanceof Error ? err.message : String(err),
        });
      }
    },

    clearConsole: () => set({ console: [] }),

    setPreserveLog: (on) => set({ preserveLog: on }),

    getProperties: async (objectId) => {
      const tabId = get().tabId;
      if (!tabId) return [];
      const res = await cdpTry<{
        result: { name: string; value?: RemoteObject; enumerable: boolean }[];
      }>(tabId, 'Runtime.getProperties', {
        objectId,
        ownProperties: true,
        generatePreview: true,
      });
      if (!res?.result) return [];
      // Own, value-bearing properties (skip accessors without a value).
      return res.result
        .filter((p) => p.value !== undefined)
        .map((p) => ({ name: p.name, value: p.value as RemoteObject }));
    },

    /* ── network ─────────────────────────────────────────────────────── */

    clearNetwork: () => set({ network: [] }),

    getResponseBody: async (requestId) => {
      const tabId = get().tabId;
      if (!tabId) return null;
      const res = await cdpTry<{ body: string; base64Encoded: boolean }>(
        tabId,
        'Network.getResponseBody',
        { requestId },
      );
      return res ?? null;
    },

    setCacheDisabled: (on) => {
      set({ cacheDisabled: on });
      void get()._applyNetworkConditions();
    },

    setThrottle: (preset) => {
      set({ throttle: preset });
      void get()._applyNetworkConditions();
    },

    _applyNetworkConditions: async () => {
      const tabId = get().tabId;
      if (!tabId || !get().enabled.has('Network')) return;
      const { cacheDisabled, throttle } = get();
      await cdpTry(tabId, 'Network.setCacheDisabled', { cacheDisabled });
      const cond =
        throttle === 'online'
          ? { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }
          : THROTTLE_CONDITIONS[throttle];
      await cdpTry(tabId, 'Network.emulateNetworkConditions', cond);
    },

    /* ── application (storage) ───────────────────────────────────────── */

    refreshApplication: async () => {
      const tabId = get().tabId;
      if (!tabId) return;
      set({ appLoading: true });
      // Resolve the page's own origin (storageId key + cookie scope). Runtime is
      // enabled from session start; a non-http origin (about:blank) yields "null".
      const originRes = await cdpTry<{ result: RemoteObject }>(tabId, 'Runtime.evaluate', {
        expression: 'location.origin',
        returnByValue: true,
      });
      if (get().tabId !== tabId) return;
      const origin =
        typeof originRes?.result?.value === 'string' &&
        originRes.result.value !== 'null'
          ? originRes.result.value
          : null;

      const readStorage = async (isLocalStorage: boolean) => {
        if (!origin) return [] as [string, string][];
        const res = await cdpTry<{ entries: [string, string][] }>(
          tabId,
          'DOMStorage.getDOMStorageItems',
          { storageId: { securityOrigin: origin, isLocalStorage } },
        );
        return res?.entries ?? [];
      };
      const [local, sessionItems, cookieRes] = await Promise.all([
        readStorage(true),
        readStorage(false),
        cdpTry<{ cookies: CdpCookie[] }>(tabId, 'Network.getCookies', {
          urls: origin ? [origin] : undefined,
        }),
      ]);
      if (get().tabId !== tabId) return;
      set({
        appOrigin: origin,
        localStorageItems: local,
        sessionStorageItems: sessionItems,
        cookies: cookieRes?.cookies ?? [],
        appLoading: false,
      });
    },

    removeStorageItem: async (isLocalStorage, key) => {
      const tabId = get().tabId;
      const origin = get().appOrigin;
      if (!tabId || !origin) return;
      await cdpTry(tabId, 'DOMStorage.removeDOMStorageItem', {
        storageId: { securityOrigin: origin, isLocalStorage },
        key,
      });
      if (get().tabId !== tabId) return;
      // Optimistic local prune (the DOMStorage event may also arrive, but the
      // panel doesn't subscribe to per-key events — re-read is the source).
      const field = isLocalStorage ? 'localStorageItems' : 'sessionStorageItems';
      set({ [field]: get()[field].filter(([k]) => k !== key) } as Partial<DevtoolsState>);
    },

    clearStorage: async (isLocalStorage) => {
      const tabId = get().tabId;
      const origin = get().appOrigin;
      if (!tabId || !origin) return;
      await cdpTry(tabId, 'DOMStorage.clear', {
        storageId: { securityOrigin: origin, isLocalStorage },
      });
      if (get().tabId !== tabId) return;
      set(
        isLocalStorage ? { localStorageItems: [] } : { sessionStorageItems: [] },
      );
    },

    clearSiteData: async () => {
      const tabId = get().tabId;
      const origin = get().appOrigin;
      if (!tabId || !origin) {
        toast({ title: 'No resolvable origin for this page', variant: 'warning' });
        return;
      }
      // Deliberate, origin-scoped wipe (not the whole-browser Storage.clearCookies,
      // which stays blocked). Clears cookies + all storage buckets for this origin.
      await cdpTry(tabId, 'Storage.clearDataForOrigin', {
        origin,
        storageTypes: 'all',
      });
      if (get().tabId !== tabId) return;
      toast({ title: 'Site data cleared', description: origin, variant: 'success' });
      await get().refreshApplication();
    },

    /* ── rendering ───────────────────────────────────────────────────── */

    setRendering: (patch) => {
      set({ rendering: { ...get().rendering, ...patch } });
      void get()._applyRendering();
    },

    _applyRendering: async () => {
      const tabId = get().tabId;
      if (!tabId) return;
      // The Overlay flags need the Overlay domain; Emulation is stateless. Enable
      // Overlay here so the Rendering panel works without first opening Elements.
      await get()._ensureDomains(['Overlay']);
      if (get().tabId !== tabId) return;
      const r = get().rendering;
      await Promise.all([
        cdpTry(tabId, 'Overlay.setShowPaintRects', { result: r.paintRects }),
        cdpTry(tabId, 'Overlay.setShowLayoutShiftRegions', { result: r.layoutShiftRegions }),
        cdpTry(tabId, 'Overlay.setShowFPSCounter', { show: r.fpsCounter }),
        cdpTry(tabId, 'Overlay.setShowScrollBottleneckRects', { show: r.scrollBottleneck }),
        cdpTry(tabId, 'Overlay.setShowWebVitals', { show: r.webVitals }),
        cdpTry(tabId, 'Emulation.setEmulatedVisionDeficiency', {
          type: r.visionDeficiency,
        }),
      ]);
      // Emulated media: 'print' overrides the media type; the feature list drives
      // prefers-color-scheme / prefers-reduced-motion (empty value = no override).
      const features: { name: string; value: string }[] = [];
      if (r.colorScheme !== 'no-override') {
        features.push({ name: 'prefers-color-scheme', value: r.colorScheme });
      }
      if (r.reducedMotion) {
        features.push({ name: 'prefers-reduced-motion', value: 'reduce' });
      }
      await cdpTry(tabId, 'Emulation.setEmulatedMedia', {
        media: r.printMedia ? 'print' : '',
        features,
      });
    },

    /* ── event ingestion ─────────────────────────────────────────────── */

    ingestBatch: (items, dropped) => {
      const effects: Array<() => void> = [];
      set((s) => {
        let nodes = s.nodes;
        let childIds = s.childIds;
        let domDirty = false;
        let consoleArr = s.console;
        let consoleDirty = false;
        let network = s.network;
        let netIndex: Map<string, number> | null = null;
        let netDirty = false;
        let styleSheets = s.styleSheets;
        let sheetsDirty = false;

        const ensureDom = () => {
          if (!domDirty) {
            nodes = new Map(nodes);
            childIds = new Map(childIds);
            domDirty = true;
          }
        };
        const ensureSheets = () => {
          if (!sheetsDirty) {
            styleSheets = new Map(styleSheets);
            sheetsDirty = true;
          }
        };
        const ensureNet = () => {
          if (!netDirty) {
            network = [...network];
            netIndex = new Map(network.map((e, i) => [e.requestId, i]));
            netDirty = true;
          } else if (!netIndex) {
            netIndex = new Map(network.map((e, i) => [e.requestId, i]));
          }
        };
        const pushConsole = (e: ConsoleEntry) => {
          if (!consoleDirty) {
            consoleArr = [...consoleArr];
            consoleDirty = true;
          }
          consoleArr.push(e);
        };

        for (const { method, params } of items) {
          const pAny = params as Record<string, unknown>;
          switch (method) {
            /* DOM */
            case 'DOM.setChildNodes': {
              ensureDom();
              const parentId = pAny.parentId as NodeId;
              const kids = (pAny.nodes as CdpNode[]) ?? [];
              for (const k of kids) indexNode(k, nodes, childIds);
              childIds.set(
                parentId,
                kids.map((k) => k.nodeId),
              );
              break;
            }
            case 'DOM.childNodeInserted': {
              ensureDom();
              const parentId = pAny.parentNodeId as NodeId;
              const prev = pAny.previousNodeId as NodeId;
              const node = pAny.node as CdpNode;
              indexNode(node, nodes, childIds);
              const list = [...(childIds.get(parentId) ?? [])];
              const at = prev === 0 ? 0 : list.indexOf(prev) + 1;
              list.splice(at, 0, node.nodeId);
              childIds.set(parentId, list);
              break;
            }
            case 'DOM.childNodeRemoved': {
              ensureDom();
              const parentId = pAny.parentNodeId as NodeId;
              const nodeId = pAny.nodeId as NodeId;
              const list = (childIds.get(parentId) ?? []).filter((x) => x !== nodeId);
              childIds.set(parentId, list);
              nodes.delete(nodeId);
              break;
            }
            case 'DOM.attributeModified': {
              ensureDom();
              const nodeId = pAny.nodeId as NodeId;
              const node = nodes.get(nodeId);
              if (node) {
                nodes.set(nodeId, {
                  ...node,
                  attributes: setAttr(
                    node.attributes,
                    pAny.name as string,
                    pAny.value as string,
                  ),
                });
              }
              break;
            }
            case 'DOM.attributeRemoved': {
              ensureDom();
              const nodeId = pAny.nodeId as NodeId;
              const node = nodes.get(nodeId);
              if (node) {
                nodes.set(nodeId, {
                  ...node,
                  attributes: removeAttr(node.attributes, pAny.name as string),
                });
              }
              break;
            }
            case 'DOM.childNodeCountUpdated': {
              ensureDom();
              const nodeId = pAny.nodeId as NodeId;
              const node = nodes.get(nodeId);
              if (node) {
                nodes.set(nodeId, {
                  ...node,
                  childNodeCount: pAny.childNodeCount as number,
                });
              }
              break;
            }
            case 'DOM.documentUpdated': {
              // Major DOM swap (e.g. document.write) without a frame nav.
              effects.push(() => void get().refreshDocument());
              break;
            }
            case 'Page.frameNavigated': {
              // Main frame only — subframes/ad-iframes carry a parentId and must
              // not thrash the session (§11.3). Re-enable domains + clear stale
              // per-page state for the new document.
              const frame = pAny.frame as { parentId?: string } | undefined;
              if (frame && frame.parentId === undefined) {
                effects.push(() => get()._handleNavigated());
              }
              break;
            }

            /* Overlay (element picker) */
            case 'Overlay.inspectNodeRequested': {
              const backendNodeId = pAny.backendNodeId as number;
              effects.push(() => void get()._finishPick(backendNodeId));
              break;
            }

            /* CSS (stylesheet headers for the source-patch hook §9-B) */
            case 'CSS.styleSheetAdded': {
              ensureSheets();
              const h = pAny.header as {
                styleSheetId: string;
                sourceURL?: string;
                origin: string;
                isInline?: boolean;
              };
              styleSheets.set(h.styleSheetId, {
                styleSheetId: h.styleSheetId,
                sourceURL: h.sourceURL ?? '',
                origin: h.origin,
                isInline: !!h.isInline,
              });
              break;
            }
            case 'CSS.styleSheetRemoved': {
              ensureSheets();
              styleSheets.delete(pAny.styleSheetId as string);
              break;
            }

            /* Console */
            case 'Runtime.consoleAPICalled': {
              pushConsole({
                id: entryId(),
                kind: consoleKindFromApi(pAny.type as string),
                args: (pAny.args as RemoteObject[]) ?? [],
                timestamp: (pAny.timestamp as number) || Date.now(),
                stackTrace: pAny.stackTrace as ConsoleEntry['stackTrace'],
              });
              break;
            }
            case 'Runtime.exceptionThrown': {
              const det = pAny.exceptionDetails as {
                text: string;
                exception?: RemoteObject;
                lineNumber?: number;
                url?: string;
                stackTrace?: ConsoleEntry['stackTrace'];
              };
              pushConsole({
                id: entryId(),
                kind: 'exception',
                args: det.exception ? [det.exception] : [],
                text: det.exception ? undefined : det.text,
                timestamp: (pAny.timestamp as number) || Date.now(),
                stackTrace: det.stackTrace,
                url: det.url,
                lineNumber: det.lineNumber,
              });
              break;
            }
            case 'Log.entryAdded': {
              const entry = pAny.entry as {
                level: string;
                text: string;
                timestamp?: number;
                url?: string;
                lineNumber?: number;
              };
              pushConsole({
                id: entryId(),
                kind: consoleKindFromLog(entry.level),
                args: [],
                text: entry.text,
                timestamp: entry.timestamp || Date.now(),
                url: entry.url,
                lineNumber: entry.lineNumber,
              });
              break;
            }

            /* Network */
            case 'Network.requestWillBeSent': {
              ensureNet();
              const requestId = pAny.requestId as string;
              const req = pAny.request as {
                url: string;
                method: string;
                headers: Record<string, string>;
              };
              const entry: NetworkEntry = {
                requestId,
                url: req.url,
                method: req.method,
                resourceType: pAny.type as string | undefined,
                startTime: pAny.timestamp as number,
                requestHeaders: req.headers,
                initiator: pAny.initiator as NetworkEntry['initiator'],
              };
              const idx = netIndex!.get(requestId);
              if (idx === undefined) {
                netIndex!.set(requestId, network.length);
                network.push(entry);
              } else {
                network[idx] = { ...network[idx], ...entry };
              }
              break;
            }
            case 'Network.responseReceived': {
              ensureNet();
              const requestId = pAny.requestId as string;
              const resp = pAny.response as {
                status: number;
                statusText: string;
                headers: Record<string, string>;
                mimeType: string;
                fromDiskCache?: boolean;
                remoteIPAddress?: string;
                timing?: NetworkEntry['timing'];
              };
              const idx = netIndex!.get(requestId);
              if (idx !== undefined) {
                network[idx] = {
                  ...network[idx],
                  status: resp.status,
                  statusText: resp.statusText,
                  responseHeaders: resp.headers,
                  mimeType: resp.mimeType,
                  fromCache: resp.fromDiskCache,
                  remoteIPAddress: resp.remoteIPAddress,
                  timing: resp.timing ?? network[idx].timing,
                  resourceType: (pAny.type as string) ?? network[idx].resourceType,
                };
              }
              break;
            }
            case 'Network.loadingFinished': {
              ensureNet();
              const requestId = pAny.requestId as string;
              const idx = netIndex!.get(requestId);
              if (idx !== undefined) {
                network[idx] = {
                  ...network[idx],
                  endTime: pAny.timestamp as number,
                  encodedDataLength: pAny.encodedDataLength as number,
                };
              }
              break;
            }
            case 'Network.loadingFailed': {
              ensureNet();
              const requestId = pAny.requestId as string;
              const idx = netIndex!.get(requestId);
              if (idx !== undefined) {
                network[idx] = {
                  ...network[idx],
                  endTime: pAny.timestamp as number,
                  failed: true,
                  errorText: pAny.errorText as string,
                };
              }
              break;
            }
          }
        }

        if (netDirty && network.length > MAX_NETWORK) {
          network = network.slice(network.length - MAX_NETWORK);
        }
        if (consoleDirty && consoleArr.length > MAX_CONSOLE) {
          consoleArr = consoleArr.slice(consoleArr.length - MAX_CONSOLE);
        }

        const next: Partial<DevtoolsState> = {};
        if (domDirty) {
          next.nodes = nodes;
          next.childIds = childIds;
        }
        if (consoleDirty) next.console = consoleArr;
        if (netDirty) next.network = network;
        if (sheetsDirty) next.styleSheets = styleSheets;
        if (dropped) next.dropped = s.dropped + dropped;
        return next;
      });
      for (const fn of effects) fn();
    },

    handleDetached: (tabId, reason) => {
      if (get().tabId !== tabId) return;
      set({ session: 'detached', detachReason: reason, picking: false });
    },
  }),
);
