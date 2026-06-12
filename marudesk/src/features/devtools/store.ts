import { create } from 'zustand';
import type { CompletionResult } from './console/completion';

// Re-exported from ./console/completion so consumers (ConsoleInput) keep a
// single import surface.
export type { CompletionKind, CompletionItem, CompletionResult } from './console/completion';
import {
  type BoxModel,
  type CacheEntry,
  type CacheInfo,
  type CdpCookie,
  type CdpNode,
  type ComputedStyleProperty,
  type ConsoleEntry,
  type CssStyle,
  type IdbDatabase,
  type IdbEntry,
  type NetworkEntry,
  type NodeId,
  type PauseOnExceptions,
  type PausedInfo,
  type RemoteObject,
  type RuleMatch,
  type ScriptInfo,
  type SourceBreakpoint,
  type StyleSheetHeader,
} from './types';
import type { PatchOp } from '../../../shared/patch';
import { loadPrefs } from './store-prefs';
import type { ToolLocation, DevtoolsTool } from './store-prefs';

// Re-exported so existing consumers (DevtoolsContent) keep importing the tool
// arrangement types from the store.
export type { ToolLocation, DevtoolsTool } from './store-prefs';
import { freshSlices } from './store-internals';
import { applyIngestBatch } from './ingest-batch';
import { createElementsSlice } from './slice-elements';
import { createConsoleSlice } from './slice-console';
import { createPanelsSlice } from './slice-panels';
import { createDockSlice } from './slice-dock';
import { createSessionSlice } from './slice-session';
import { createSourcesSlice } from './slice-sources';

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
  | 'sources'
  | 'timeline'
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


/** Network throttling presets (Network.emulateNetworkConditions params). */
export type ThrottlePreset = 'online' | 'fast3g' | 'slow3g' | 'offline';

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
  // sources (Debugger) — per-page script list + viewer + pause machine.
  // scriptId → info, fed by Debugger.scriptParsed (urlless/internal scripts are
  // skipped at ingest). Reset per page (the ids die with the document).
  scripts: Map<string, ScriptInfo>;
  selectedScriptId: string | null;
  scriptSource: string | null;
  scriptSourceLoading: boolean;
  // Scroll-to target in the viewer. `seq` bumps on every reveal so revealing
  // the same line twice still re-scrolls.
  reveal: { line: number; seq: number } | null;
  // URL-keyed breakpoints — sticky across navigations AND re-attach (like the
  // rendering toggles): CDP keeps url breakpoints across reloads within a
  // session, and `_applySources` re-sets them on a fresh attach.
  breakpoints: SourceBreakpoint[];
  // Sticky Debugger.setPauseOnExceptions state, re-applied on (re)attach.
  pauseOnExceptions: PauseOnExceptions;
  // Non-null while the page is stopped (Debugger.paused → Debugger.resumed).
  paused: PausedInfo | null;
  // application (storage) — resolved from the bound tab's URL on panel open.
  appOrigin: string | null;
  localStorageItems: [string, string][];
  sessionStorageItems: [string, string][];
  cookies: CdpCookie[];
  // IndexedDB databases + CacheStorage caches of the origin (read on refresh;
  // entries are pulled on demand via loadIdbEntries / loadCacheEntries).
  idbDatabases: IdbDatabase[];
  cacheNames: CacheInfo[];
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
  // sources (Debugger)
  /** Show a script in the viewer (fetches its source on first selection). */
  selectScript: (scriptId: string) => Promise<void>;
  /** Select a script and scroll the viewer to a 0-based line. */
  openScriptAt: (scriptId: string, lineNumber: number) => Promise<void>;
  /** Reveal a breakpoint's location (resolves the script by URL). */
  revealBreakpoint: (bp: SourceBreakpoint) => Promise<void>;
  /** Gutter click: set/remove a url:line breakpoint (setBreakpointByUrl). */
  toggleBreakpoint: (url: string, lineNumber: number) => Promise<void>;
  setPauseOnExceptions: (state: PauseOnExceptions) => void;
  pause: () => void;
  resume: () => void;
  stepOver: () => void;
  stepInto: () => void;
  stepOut: () => void;
  /** Focus a call-stack frame: scope pane + viewer follow it. */
  selectCallFrame: (index: number) => void;
  /** Re-apply sticky debugger state (breakpoints + pause-on-exceptions) after
   *  the Debugger domain is freshly enabled on a (re)attach. */
  _applySources: () => Promise<void>;
  /** `Debugger.paused` event → pause snapshot + reveal the top frame. */
  _handlePaused: (params: unknown) => void;
  _handleResumed: () => void;
  // application (storage)
  refreshApplication: () => Promise<void>;
  removeStorageItem: (isLocalStorage: boolean, key: string) => Promise<void>;
  clearStorage: (isLocalStorage: boolean) => Promise<void>;
  clearSiteData: () => Promise<void>;
  /** First page of an object store's entries (read-only preview). */
  loadIdbEntries: (databaseName: string, objectStoreName: string) => Promise<IdbEntry[]>;
  deleteIdbDatabase: (databaseName: string) => Promise<void>;
  /** First page of a cache's entries (capped). */
  loadCacheEntries: (cacheId: string) => Promise<CacheEntry[]>;
  deleteCache: (cacheId: string) => Promise<void>;
  deleteCacheEntry: (cacheId: string, requestURL: string) => Promise<void>;
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
    // Sticky debugger preferences — survive freshSlices, re-applied on attach.
    breakpoints: [],
    pauseOnExceptions: 'none',
    tabId: null,
    session: 'idle',
    detachReason: null,
    enabled: new Set(),
    epoch: 0,
    ...freshSlices(),

    /* ── dock lifecycle ──────────────────────────────────────────────── */


    ...createDockSlice(set, get),
    ...createSessionSlice(set, get),


    ...createElementsSlice(set, get),

    /* ── console ─────────────────────────────────────────────────────── */

    ...createConsoleSlice(set, get),

    /* ── sources (debugger) ──────────────────────────────────────────── */

    ...createSourcesSlice(set, get),

    /* ── network ─────────────────────────────────────────────────────── */

    ...createPanelsSlice(set, get),


    ingestBatch: (items, dropped) => applyIngestBatch(set, get, items, dropped),

  }),
);
