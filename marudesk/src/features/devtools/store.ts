import { create } from 'zustand';
import { useTabsStore } from '../tabs/store';
import { useGridStore, groupForTab } from '../tabs/grid';
import { useSettingsStore } from '../settings/store';
import { useWebPageStore } from '../browser/store';
import { toast } from '../../lib/toast';
import { cdpSend, cdpTry } from './cdp';
import {
  COMMAND_LINE_API,
  dedupe,
  globalObjectProperties,
  MAX_COMPLETIONS,
  memberCompletions,
  parseCompletionContext,
  rankCompletions,
} from './console/completion';
import type { CompletionItem, CompletionResult } from './console/completion';

// Re-exported from ./console/completion so consumers (ConsoleInput) keep a
// single import surface.
export type { CompletionKind, CompletionItem, CompletionResult } from './console/completion';
import { consoleEntryToErrorCapture } from './capture';
import {
  type BoxModel,
  type CdpCookie,
  type CdpNode,
  type ComputedStyleProperty,
  type ConsoleEntry,
  type CssStyle,
  type NetworkEntry,
  type NodeId,
  type RemoteObject,
  type RuleMatch,
  type StyleSheetHeader,
} from './types';
import type { PatchOp } from '../../../shared/patch';
import {
  DRAWER_MIN,
  firstInLocation,
  loadPrefs,
  savePrefs,
  snapshotPrefs,
} from './store-prefs';
import type { ToolLocation, DevtoolsTool } from './store-prefs';

// Re-exported so existing consumers (DevtoolsContent) keep importing the tool
// arrangement types from the store.
export type { ToolLocation, DevtoolsTool } from './store-prefs';
import { entryId, msg, freshSlices, DEFAULT_SIZE, MIN_SIZE, MAX_CONSOLE } from './store-internals';
import { applyIngestBatch } from './ingest-batch';
import { createElementsSlice } from './slice-elements';

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

const MAX_HISTORY = 200;

/* ── tool arrangement + bottom drawer: extracted to ./store-prefs.ts ──────── */

/* ── Console autocomplete: helpers + types extracted to ./console/completion.ts ── */

export type DevtoolsState = {
  // dock UI
  open: boolean;
  side: DockSide;
  size: number;
  // The active tool in the MAIN (top) tab bar. When this panel is moved to the
  // drawer, `panel` follows to the next remaining main tool (see `_reflowActive`).
  panel: DevtoolsPanel;
  // User-arrangeable tool tabs: each tool lives in the main bar or the bottom
  // drawer (§drawer). Persisted to localStorage; Console defaults to the main bar.
  tools: DevtoolsTool[];
  // Bottom drawer (Chrome-style): a secondary panel surface pinned below the
  // main panel, visible while ANY main panel is shown. Open state + height are
  // persisted; `drawerPanel` is the active tool within the drawer.
  drawerOpen: boolean;
  drawerHeight: number;
  drawerPanel: DevtoolsPanel;
  // True when this store instance backs the pop-out DevtoolsWindow (its own
  // renderer) rather than the in-page dock. Drives full-bleed layout and hides
  // the host-only "Add to AI context" capture (the composer lives in the main
  // window — cross-window capture is out of scope).
  windowMode: boolean;
  // Always-on console-error counts per tab (P0), mirrored from main via
  // devtools:error-count. Cross-tab + survives freshSlices/rebind so the toggle
  // badge is correct for whichever web tab is active — dock open or not.
  errorCountByTab: Record<string, number>;
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
  // REPL command history (most-recent last), for ↑/↓ recall and as autocomplete
  // candidates (§autocomplete). A session-scoped UI convenience: survives
  // freshSlices/navigation (not per-page state), capped at MAX_HISTORY.
  commandHistory: string[];
  // When true, a main-frame navigation keeps the existing console entries
  // (DevTools' "Preserve log") — `_handleNavigated` reads this. Sticky across
  // navigations; survives freshSlices (a UI preference, not per-page state).
  preserveLog: boolean;
  // Console row gutter timestamps (DevTools' "Show timestamps"). A display-only
  // UI preference; survives freshSlices like the filters above.
  showTimestamps: boolean;
  // network
  network: NetworkEntry[];
  // When true, network rows survive a main-frame navigation (DevTools' Network
  // "Preserve log"). The requestIds become historical (response bodies may be
  // evicted), but the rows stay for cross-navigation diffing. UI preference.
  preserveNetworkLog: boolean;
  // Page lifecycle timing for the Network summary bar, all CDP monotonic seconds
  // and per-page (reset on navigation). `navStart` is the first request's start
  // (the navigation baseline); DOMContentLoaded / Load come from the Page domain.
  navStartTime: number | null;
  domContentTime: number | null;
  loadTime: number | null;
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

export type DevtoolsActions = {
  toggle: () => void;
  reconnect: () => void;
  close: () => void;
  popOut: () => void;
  setWindowMode: (on: boolean) => void;
  setPanel: (panel: DevtoolsPanel) => void;
  setSide: (side: DockSide) => void;
  setSize: (size: number) => void;
  // Bottom drawer + tool arrangement (Chrome-style).
  setDrawerPanel: (panel: DevtoolsPanel) => void;
  toggleDrawer: () => void;
  setDrawerOpen: (open: boolean) => void;
  setDrawerHeight: (height: number) => void;
  /** Move a tool between the main tab bar and the bottom drawer (1b). */
  moveTool: (id: DevtoolsPanel, location: ToolLocation) => void;
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
  /**
   * As-you-type Console completion (§autocomplete). Given the full input and the
   * caret offset, resolve the token being typed and return ranked candidates:
   * member completion (`obj.` / `obj[`) walks the receiver's prototype chain via
   * Runtime.getProperties; global completion merges lexical scope names, the
   * global object's properties, the Command Line API helpers, and command
   * history. Failures are swallowed (returns `[]`) so typing never blocks.
   */
  getCompletions: (
    input: string,
    caret: number,
    /** Manual trigger (Ctrl+Space): list candidates even with an empty token. */
    force?: boolean,
  ) => Promise<CompletionResult>;
  clearConsole: () => void;
  setPreserveLog: (on: boolean) => void;
  setShowTimestamps: (on: boolean) => void;
  /** Mirror main's per-tab error count (devtools:error-count) for the badge. */
  setErrorCount: (tabId: string, count: number) => void;
  /** "Fix this": send a console error/exception row to the AI composer cart. */
  captureConsoleError: (entryId: string) => void;
  getProperties: (
    objectId: string,
  ) => Promise<{ name: string; value: RemoteObject }[]>;
  // network
  clearNetwork: () => void;
  setPreserveNetworkLog: (on: boolean) => void;
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
  /**
   * Pull main's buffered errors for a tab and seed the console (on open). Only
   * errors older than `since` (the bind time) are seeded — newer ones arrive
   * live via the relay, so seeding them would double the row.
   */
  _seedConsoleErrors: (tabId: string, since: number) => Promise<void>;
  _pushConsole: (entry: Omit<ConsoleEntry, 'id' | 'timestamp'> & { timestamp?: number }) => void;
  _finishPick: (backendNodeId: number) => Promise<void>;
  _revealAndSelect: (nodeId: NodeId) => Promise<void>;
  _offerSourcePatch: (
    styleSheetId: string,
    oldBlock: string,
    newBlock: string,
  ) => Promise<void>;
};


/* ── DOM indexing + console-kind helpers extracted to ./dom-index, ./console-kind ── */
/* ── entryId + network-payload helpers extracted to ./store-internals ─────── */

export const useDevtoolsStore = create<DevtoolsState & DevtoolsActions>(
  (set, get) => ({
    open: false,
    side: 'right',
    size: 0,
    panel: 'elements',
    ...((): Pick<DevtoolsState, 'tools' | 'drawerOpen' | 'drawerHeight' | 'drawerPanel'> => {
      const p = loadPrefs();
      return {
        tools: p.tools,
        drawerOpen: p.drawerOpen,
        drawerHeight: p.drawerHeight,
        drawerPanel: p.drawerPanel,
      };
    })(),
    windowMode: false,
    errorCountByTab: {},
    preserveLog: false,
    showTimestamps: false,
    preserveNetworkLog: false,
    commandHistory: [],
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
      if (groupForTab(useGridStore.getState().groups, useTabsStore.getState().activeTabId) !== null) {
        toast({
          title: msg('devtools.toast.exitGrid'),
          description: msg('devtools.toast.exitGridDescription'),
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
      const since = Date.now(); // boundary: live errors after this aren't seeded
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
      // The drawer's panel is a second visible surface — enable its domains too.
      if (get().drawerOpen && get().drawerPanel !== get().panel) {
        await get()._enablePanel(get().drawerPanel);
        if (get().epoch !== epoch) return;
      }
      // Seed the console with errors main buffered before the dock opened.
      void get()._seedConsoleErrors(tabId, since);
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

    /* ── bottom drawer + tool arrangement ───────────────────────────────── */

    setDrawerPanel: (panel) => {
      if (get().drawerPanel === panel) return;
      set({ drawerPanel: panel });
      savePrefs(snapshotPrefs(get()));
      if (get().session === 'attached') void get()._enablePanel(panel);
    },

    toggleDrawer: () => get().setDrawerOpen(!get().drawerOpen),

    setDrawerOpen: (open) => {
      if (get().drawerOpen === open) return;
      set({ drawerOpen: open });
      savePrefs(snapshotPrefs(get()));
      // Enabling the drawer's panel lazily mirrors setPanel — its CDP domains
      // (e.g. Network) only turn on when the surface is actually shown.
      if (open && get().session === 'attached') void get()._enablePanel(get().drawerPanel);
    },

    setDrawerHeight: (height) => {
      set({ drawerHeight: Math.max(DRAWER_MIN, Math.round(height)) });
      savePrefs(snapshotPrefs(get()));
    },

    moveTool: (id, location) => {
      const s = get();
      const tool = s.tools.find((t) => t.id === id);
      if (!tool || tool.location === location) return;
      // Append to the end of the destination location's order.
      const maxOrder = s.tools
        .filter((t) => t.location === location)
        .reduce((m, t) => Math.max(m, t.order), -1);
      const tools = s.tools.map((t) =>
        t.id === id ? { ...t, location, order: maxOrder + 1 } : t,
      );

      const patch: Partial<DevtoolsState> = { tools };
      // If the moved tool was the active tab of its old location, hand activity
      // to the next remaining tool there so the surface never points at a tool
      // that's no longer present.
      if (tool.location === 'main' && s.panel === id) {
        const next = firstInLocation(tools, 'main');
        if (next) patch.panel = next;
      }
      if (tool.location === 'drawer' && s.drawerPanel === id) {
        const next = firstInLocation(tools, 'drawer');
        if (next) patch.drawerPanel = next;
      }
      // Make the moved tool the active tab in its NEW location, and reveal the
      // drawer when something lands there (so "Move to bottom" is visible).
      if (location === 'main') patch.panel = id;
      else {
        patch.drawerPanel = id;
        patch.drawerOpen = true;
      }

      set(patch);
      savePrefs(snapshotPrefs(get()));
      if (get().session === 'attached') void get()._enablePanel(id);
    },

    rebindToActive: (tabId) => {
      const s = get();
      if (!s.open) return;
      if (tabId === s.tabId) return;
      // Active tab left the web kind (feature tab) — the dock unmounts with the
      // browser stage; keep the session so returning to this tab is instant.
      if (tabId === null) return;
      const old = s.tabId;
      const epoch = s.epoch + 1;
      const since = Date.now(); // boundary: live errors after this aren't seeded
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
        if (get().drawerOpen && get().drawerPanel !== get().panel) {
          await get()._enablePanel(get().drawerPanel);
          if (get().epoch !== epoch) return;
        }
        void get()._seedConsoleErrors(tabId, since);
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
      // new document. Console + network are each kept iff their "Preserve log"
      // toggle is on (DevTools' behavior); DOM/styles always reset — those
      // nodeIds are meaningless on the new document. Page timing always resets.
      set({
        enabled: new Set(),
        ...(get().preserveLog ? {} : { console: [] }),
        ...(get().preserveNetworkLog ? {} : { network: [] }),
        // Page timing is always per-document — reset even when logs are preserved.
        navStartTime: null,
        domContentTime: null,
        loadTime: null,
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
        if (get().drawerOpen && get().drawerPanel !== get().panel) {
          await get()._enablePanel(get().drawerPanel);
          if (get().epoch !== epoch) return;
        }
        // Navigation clears emulation/overlay overrides — re-apply the sticky ones.
        if (hasRenderingOverrides(get().rendering)) await get()._applyRendering();
      })();
    },

    _seedConsoleErrors: async (tabId, since) => {
      // Always-on capture buffers errors in main even before the dock opens.
      // Pull them on (re)attach and prepend as exception rows so "Fix this" (and
      // the operator) sees errors that predate opening the dock.
      let errors;
      try {
        errors = await window.marudesk.invoke('devtools:pull-errors', { tabId });
      } catch {
        return; // best-effort seed
      }
      if (get().tabId !== tabId) return;
      // Only seed errors that predate the bind (`since`); newer ones arrive live
      // via the relay (with their own entry ids), so seeding them too would
      // double the row. CDP timestamps are ms-since-epoch — comparable to the
      // Date.now() boundary captured at open.
      const seeded = errors
        .filter((ev) => ev.timestamp < since)
        .map(
          (ev): ConsoleEntry => ({
            id: ev.id,
            kind: 'exception',
            args: [],
            text: ev.message,
            timestamp: ev.timestamp,
            stackTrace: ev.stack.length ? { callFrames: ev.stack } : undefined,
            url: ev.source?.url,
            lineNumber: ev.source?.lineNumber,
          }),
        );
      if (seeded.length === 0) return;
      // These predate everything captured live since open → prepend (oldest first).
      set((s) => ({ console: [...seeded, ...s.console] }));
    },

    /* ── elements ────────────────────────────────────────────────────── */

    ...createElementsSlice(set, get),

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
      // Record into history (most-recent last, de-duped against the previous
      // entry, capped) — drives ↑/↓ recall and history-backed completion.
      {
        const trimmed = expression.trim();
        const hist = get().commandHistory;
        if (hist[hist.length - 1] !== trimmed) {
          const next = [...hist, trimmed];
          if (next.length > MAX_HISTORY) next.splice(0, next.length - MAX_HISTORY);
          set({ commandHistory: next });
        }
      }
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

    getCompletions: async (input, caret, force = false) => {
      const empty: CompletionResult = { prefix: '', items: [] };
      const tabId = get().tabId;
      if (!tabId) return empty;
      const ctx = parseCompletionContext(input, caret, force);
      if (!ctx) return empty;

      // Member completion: `obj.frag` / `obj[frag` → properties of the receiver.
      if (ctx.kind === 'member') {
        const names = await memberCompletions(tabId, ctx.receiver);
        const items = names.map(
          (text): CompletionItem => ({ text, kind: 'property', replace: 'token' }),
        );
        return rankCompletions(ctx.prefix, dedupe(items));
      }

      // Global completion: lexical names + global-object props + Command Line API
      // helpers, ranked by the typed token. Each replaces just the token.
      const identifiers: CompletionItem[] = [];
      const lexical = await cdpTry<{ names: string[] }>(
        tabId,
        'Runtime.globalLexicalScopeNames',
      );
      for (const n of lexical?.names ?? [])
        identifiers.push({ text: n, kind: 'global', replace: 'token' });

      const globals = await globalObjectProperties(tabId);
      for (const n of globals) identifiers.push({ text: n, kind: 'global', replace: 'token' });

      for (const n of COMMAND_LINE_API)
        identifiers.push({ text: n, kind: 'command-api', replace: 'token' });

      const ranked = rankCompletions(ctx.prefix, dedupe(identifiers));

      // History entries (the UI prefixes them with `>`) recall a WHOLE prior
      // command, so they match against the full pre-caret input and replace it
      // all. Appended after identifier matches and de-duped against them.
      const full = input.slice(0, Math.max(0, caret)).trimStart();
      const taken = new Set(ranked.items.map((i) => i.text));
      const history: CompletionItem[] = [];
      if (full) {
        const seen = new Set<string>();
        // Most-recent first for history.
        for (let i = get().commandHistory.length - 1; i >= 0; i--) {
          const h = get().commandHistory[i];
          if (h === full || seen.has(h) || taken.has(h)) continue;
          if (h.startsWith(full)) {
            seen.add(h);
            history.push({ text: h, kind: 'history', replace: 'all' });
          }
        }
      }

      return {
        prefix: ctx.prefix,
        items: [...ranked.items, ...history].slice(0, MAX_COMPLETIONS),
      };
    },

    clearConsole: () => set({ console: [] }),

    setPreserveLog: (on) => set({ preserveLog: on }),

    setShowTimestamps: (on) => set({ showTimestamps: on }),

    setErrorCount: (tabId, count) =>
      set((s) => {
        if (s.errorCountByTab[tabId] === count) return {};
        return { errorCountByTab: { ...s.errorCountByTab, [tabId]: count } };
      }),

    captureConsoleError: (entryId) => {
      const entry = get().console.find((e) => e.id === entryId);
      if (!entry || (entry.kind !== 'error' && entry.kind !== 'exception')) return;
      // Page URL (not the script URL) — its origin drives the deterministic
      // stack→workspace-file resolution in electron/llm.ts.
      const url = useWebPageStore.getState().currentUrl;
      const capture = consoleEntryToErrorCapture(entry, url);
      useWebPageStore.getState().addCapture(capture);
      toast({
        title: msg('devtools.toast.addedToContext'),
        description: capture.message.slice(0, 80),
        variant: 'success',
      });
    },

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

    clearNetwork: () =>
      set({ network: [], navStartTime: null, domContentTime: null, loadTime: null }),

    setPreserveNetworkLog: (on) => set({ preserveNetworkLog: on }),

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
        toast({ title: msg('devtools.toast.noOrigin'), variant: 'warning' });
        return;
      }
      // Deliberate, origin-scoped wipe (not the whole-browser Storage.clearCookies,
      // which stays blocked). Clears cookies + all storage buckets for this origin.
      await cdpTry(tabId, 'Storage.clearDataForOrigin', {
        origin,
        storageTypes: 'all',
      });
      if (get().tabId !== tabId) return;
      toast({ title: msg('devtools.toast.siteDataCleared'), description: origin, variant: 'success' });
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

    ingestBatch: (items, dropped) => applyIngestBatch(set, get, items, dropped),

    handleDetached: (tabId, reason) => {
      if (get().tabId !== tabId) return;
      set({ session: 'detached', detachReason: reason, picking: false });
    },
  }),
);
