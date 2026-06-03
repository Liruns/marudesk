import { create } from 'zustand';
import { useTabsStore } from '../tabs/store';
import { useGridStore, groupForTab } from '../tabs/grid';
import { useSettingsStore } from '../settings/store';
import { useWebPageStore } from '../browser/store';
import { toast } from '../../lib/toast';
import { toMessage } from '../../lib/toMessage';
import { cdpSend, cdpTry } from './cdp';
import { buildCapture, consoleEntryToErrorCapture } from './capture';
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
const MAX_HISTORY = 200;

/* ── tool arrangement + bottom drawer (Chrome-style) ─────────────────────── */

/** Where a DevTools tool's tab lives: the main (top) tab bar or the bottom drawer. */
export type ToolLocation = 'main' | 'drawer';

/**
 * One arrangeable DevTools tool. `order` sorts tabs within each location. The
 * arrangement is a user preference persisted to localStorage (like the dock
 * side/size) — Console defaults to the drawer so you can read it while another
 * panel (Elements/Network/…) is shown in the main area.
 */
export type DevtoolsTool = {
  id: DevtoolsPanel;
  location: ToolLocation;
  order: number;
};

/** The default arrangement: Console in the drawer, everything else in the main bar. */
const DEFAULT_TOOLS: DevtoolsTool[] = [
  { id: 'elements', location: 'main', order: 0 },
  { id: 'network', location: 'main', order: 1 },
  { id: 'application', location: 'main', order: 2 },
  { id: 'rendering', location: 'main', order: 3 },
  { id: 'console', location: 'drawer', order: 0 },
];

const PANEL_IDS: ReadonlySet<DevtoolsPanel> = new Set<DevtoolsPanel>([
  'elements',
  'console',
  'network',
  'application',
  'rendering',
]);

const DRAWER_MIN = 80;
const DRAWER_DEFAULT_HEIGHT = 220;

/* Persisted dock/tool preferences (localStorage). Kept separate from the CDP
 * session state, which is always reset per-page (freshSlices). Best-effort:
 * a malformed/absent blob falls back to defaults, mirroring workspace recents. */
const PREFS_KEY = 'marudesk.devtools.prefs.v1';

type DevtoolsPrefs = {
  tools: DevtoolsTool[];
  drawerOpen: boolean;
  drawerHeight: number;
  drawerPanel: DevtoolsPanel;
};

/** Coerce arbitrary stored JSON back into a valid tool arrangement (covering
 * every known panel exactly once) so a renamed/removed panel can't corrupt it. */
function sanitizeTools(input: unknown): DevtoolsTool[] {
  if (!Array.isArray(input)) return DEFAULT_TOOLS.map((t) => ({ ...t }));
  const seen = new Map<DevtoolsPanel, DevtoolsTool>();
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const id = r.id as DevtoolsPanel;
    if (!PANEL_IDS.has(id) || seen.has(id)) continue;
    seen.set(id, {
      id,
      location: r.location === 'drawer' ? 'drawer' : 'main',
      order: typeof r.order === 'number' && Number.isFinite(r.order) ? r.order : 0,
    });
  }
  // Backfill any panel the stored blob didn't mention (e.g. a newly-added one)
  // from the defaults, so the union is always fully covered.
  for (const def of DEFAULT_TOOLS) {
    if (!seen.has(def.id)) seen.set(def.id, { ...def });
  }
  return [...seen.values()];
}

function loadPrefs(): DevtoolsPrefs {
  const fallback: DevtoolsPrefs = {
    tools: DEFAULT_TOOLS.map((t) => ({ ...t })),
    drawerOpen: false,
    drawerHeight: DRAWER_DEFAULT_HEIGHT,
    drawerPanel: 'console',
  };
  try {
    const parsed = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null');
    if (!parsed || typeof parsed !== 'object') return fallback;
    const tools = sanitizeTools(parsed.tools);
    const drawerPanel = PANEL_IDS.has(parsed.drawerPanel)
      ? (parsed.drawerPanel as DevtoolsPanel)
      : 'console';
    return {
      tools,
      drawerOpen: typeof parsed.drawerOpen === 'boolean' ? parsed.drawerOpen : false,
      drawerHeight:
        typeof parsed.drawerHeight === 'number' && Number.isFinite(parsed.drawerHeight)
          ? Math.max(DRAWER_MIN, Math.round(parsed.drawerHeight))
          : DRAWER_DEFAULT_HEIGHT,
      drawerPanel,
    };
  } catch {
    return fallback;
  }
}

function savePrefs(p: DevtoolsPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // best-effort (private mode / quota)
  }
}

/** Pull the persistable preference subset out of the live store state. */
function snapshotPrefs(s: {
  tools: DevtoolsTool[];
  drawerOpen: boolean;
  drawerHeight: number;
  drawerPanel: DevtoolsPanel;
}): DevtoolsPrefs {
  return {
    tools: s.tools,
    drawerOpen: s.drawerOpen,
    drawerHeight: s.drawerHeight,
    drawerPanel: s.drawerPanel,
  };
}

/** First tool (by order) in a location, or null when the location is empty. */
function firstInLocation(tools: DevtoolsTool[], loc: ToolLocation): DevtoolsPanel | null {
  const inLoc = tools.filter((t) => t.location === loc).sort((a, b) => a.order - b.order);
  return inLoc[0]?.id ?? null;
}

/* ── Console autocomplete helpers ─────────────────────────────────────────── */

/** Chrome's Command Line API helpers, offered as static global candidates. */
const COMMAND_LINE_API: readonly string[] = [
  '$_',
  '$0',
  '$1',
  '$2',
  '$3',
  '$4',
  '$',
  '$$',
  '$x',
  'inspect',
  'copy',
  'getEventListeners',
  'monitorEvents',
  'unmonitorEvents',
  'monitor',
  'unmonitor',
  'debug',
  'undebug',
  'keys',
  'values',
  'clear',
  'dir',
  'dirxml',
  'table',
  'queryObjects',
  'profile',
  'profileEnd',
];

const COMPLETION_GROUP = 'completion';
/** Cap the candidate list so a huge global scope can't blow up the dropdown. */
const MAX_COMPLETIONS = 50;

type CompletionContext =
  | { kind: 'member'; receiver: string; prefix: string }
  | { kind: 'global'; prefix: string };

/** A JS identifier-start / -part test (ASCII subset — enough for completion). */
function isIdentChar(c: string): boolean {
  return /[A-Za-z0-9_$]/.test(c);
}

/**
 * Classify what's being typed at `caret`. Only the text BEFORE the caret matters.
 * Walks back over an identifier fragment to its start; if the char before the
 * fragment is `.` (or a `[` with a bare identifier after it), the token before
 * that operator is the receiver to evaluate, and we're completing a member.
 * Otherwise it's a bare-identifier (global) completion. Returns null when there's
 * nothing completable (e.g. caret right after whitespace with no fragment and no
 * preceding `.`), so the caller can clear the popup.
 */
function parseCompletionContext(
  input: string,
  caret: number,
  force: boolean,
): CompletionContext | null {
  const upto = input.slice(0, Math.max(0, caret));
  // The fragment = trailing run of identifier chars (may be empty, e.g. `foo.`).
  let i = upto.length;
  while (i > 0 && isIdentChar(upto[i - 1])) i--;
  const prefix = upto.slice(i);
  const before = upto.slice(0, i);

  // Member access: `<receiver>.` or `<receiver>[`  (optionally with the fragment
  // already typed). We support the common dot and bare-bracket forms; a bracket
  // with an opening quote (`obj['fo`) is treated as a member too (string key).
  const opMatch = before.match(/(.*?)\s*(\.|\[\s*['"]?)\s*$/s);
  if (opMatch) {
    const receiver = extractReceiver(opMatch[1]);
    if (receiver) return { kind: 'member', receiver, prefix };
  }

  // Global completion: as-you-type only when there's a fragment to complete; a
  // manual trigger (Ctrl+Space) lists everything even on an empty token.
  if (prefix.length === 0 && !force) return null;
  return { kind: 'global', prefix };
}

/**
 * From the text left of a `.`/`[`, pull the receiver expression to evaluate.
 * Handles trailing call/index chains (`a.b().c[0].` → `a.b().c[0]`) by scanning
 * back while brackets are balanced and the run looks like a property/call chain.
 * Bails (returns null) on anything that doesn't end in an identifier, `)`, or `]`
 * — evaluating those would be pointless or unsafe.
 */
function extractReceiver(left: string): string | null {
  const s = left.replace(/\s+$/, '');
  if (!s) return null;
  const last = s[s.length - 1];
  if (!isIdentChar(last) && last !== ')' && last !== ']') return null;
  let i = s.length;
  let depth = 0;
  while (i > 0) {
    const c = s[i - 1];
    if (c === ')' || c === ']') depth++;
    else if (c === '(' || c === '[') {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && !isIdentChar(c) && c !== '.') {
      break;
    }
    i--;
  }
  const receiver = s.slice(i).trim();
  return receiver.length > 0 ? receiver : null;
}

/**
 * Evaluate the receiver and collect property names down its prototype chain
 * (so inherited members like array/DOM methods appear). Side-effect-free + scoped
 * to a disposable objectGroup, released at the end. Returns [] on any failure.
 */
async function memberCompletions(tabId: string, receiver: string): Promise<string[]> {
  try {
    const ev = await cdpSend<{ result: RemoteObject; exceptionDetails?: unknown }>(
      tabId,
      'Runtime.evaluate',
      {
        expression: receiver,
        objectGroup: COMPLETION_GROUP,
        includeCommandLineAPI: true,
        throwOnSideEffect: true,
        returnByValue: false,
      },
    );
    if (ev.exceptionDetails || !ev.result) return [];
    const obj = ev.result;
    const names = new Set<string>();

    if (obj.objectId) {
      // Walk own + inherited enumerable/non-enumerable names. accessorPropertiesOnly
      // off → data props; generatePreview off → cheaper.
      const res = await cdpTry<{
        result: { name: string; symbol?: unknown }[];
        internalProperties?: unknown;
      }>(tabId, 'Runtime.getProperties', {
        objectId: obj.objectId,
        ownProperties: false,
        generatePreview: false,
      });
      for (const p of res?.result ?? []) {
        if (typeof p.name === 'string' && !p.symbol) names.add(p.name);
      }
    } else if (obj.type === 'string') {
      // Primitive string: offer String.prototype members via a boxed lookup.
      const res = await cdpTry<{ result: RemoteObject }>(tabId, 'Runtime.evaluate', {
        expression: 'String.prototype',
        objectGroup: COMPLETION_GROUP,
        returnByValue: false,
      });
      const pid = res?.result.objectId;
      if (pid) {
        const props = await cdpTry<{ result: { name: string }[] }>(
          tabId,
          'Runtime.getProperties',
          { objectId: pid, ownProperties: false, generatePreview: false },
        );
        for (const p of props?.result ?? []) names.add(p.name);
      }
    }
    return [...names];
  } catch {
    return [];
  } finally {
    void cdpTry(tabId, 'Runtime.releaseObjectGroup', { objectGroup: COMPLETION_GROUP });
  }
}

/** Own + inherited enumerable property names of the global object. */
async function globalObjectProperties(tabId: string): Promise<string[]> {
  const ev = await cdpTry<{ result: RemoteObject }>(tabId, 'Runtime.evaluate', {
    expression: 'globalThis',
    objectGroup: COMPLETION_GROUP,
    returnByValue: false,
  });
  const objectId = ev?.result.objectId;
  if (!objectId) return [];
  const res = await cdpTry<{ result: { name: string; symbol?: unknown }[] }>(
    tabId,
    'Runtime.getProperties',
    { objectId, ownProperties: false, generatePreview: false },
  );
  void cdpTry(tabId, 'Runtime.releaseObjectGroup', { objectGroup: COMPLETION_GROUP });
  const names: string[] = [];
  for (const p of res?.result ?? []) {
    if (typeof p.name === 'string' && !p.symbol) names.push(p.name);
  }
  return names;
}

/** Drop duplicate texts, keeping the first (highest-priority) kind seen. */
function dedupe(items: CompletionItem[]): CompletionItem[] {
  const seen = new Set<string>();
  const out: CompletionItem[] = [];
  for (const it of items) {
    if (seen.has(it.text)) continue;
    seen.add(it.text);
    out.push(it);
  }
  return out;
}

/**
 * Filter candidates by `prefix` and rank them: case-sensitive prefix matches
 * first, then case-insensitive prefix, then case-insensitive substring; ties
 * broken by shorter text then lexicographically. An empty prefix returns the
 * list as-is (capped) so an explicit trigger after `obj.` lists everything.
 */
function rankCompletions(prefix: string, items: CompletionItem[]): CompletionResult {
  if (!prefix) return { prefix, items: items.slice(0, MAX_COMPLETIONS) };
  const p = prefix;
  const lower = p.toLowerCase();
  const scored: { it: CompletionItem; score: number }[] = [];
  for (const it of items) {
    const t = it.text;
    let score: number;
    if (t.startsWith(p)) score = 0;
    else if (t.toLowerCase().startsWith(lower)) score = 1;
    else if (t.toLowerCase().includes(lower)) score = 2;
    else continue;
    scored.push({ it, score });
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    if (a.it.text.length !== b.it.text.length) return a.it.text.length - b.it.text.length;
    return a.it.text < b.it.text ? -1 : a.it.text > b.it.text ? 1 : 0;
  });
  return { prefix, items: scored.slice(0, MAX_COMPLETIONS).map((s) => s.it) };
}

/* ── Console autocomplete ─────────────────────────────────────────────────
 * The kind drives the candidate row's tint/icon; it does not affect ranking. */
export type CompletionKind =
  | 'property' // member of the evaluated receiver
  | 'global' // window / globalThis property or lexical scope name
  | 'command-api' // Command Line API helper ($0, $$, inspect, …)
  | 'history'; // a prior REPL command (prefixed `>` in the UI)

/**
 * `replace` says what accepting the item rewrites:
 * - `token`: the typed token slice `[caret - prefix.length, caret)` (identifiers,
 *   members, Command Line API helpers).
 * - `all`: the ENTIRE input (history entries — a recalled full command line).
 */
export type CompletionItem = {
  text: string;
  kind: CompletionKind;
  replace: 'token' | 'all';
};

/**
 * One completion pass. `prefix` is the partial token the token-kind candidates
 * complete (the substring from the token start to the caret); its input range is
 * `[caret - prefix.length, caret)`. `items` are already filtered + ranked.
 */
export type CompletionResult = { prefix: string; items: CompletionItem[] };

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
  // The active tool in the MAIN (top) tab bar. When this panel is moved to the
  // drawer, `panel` follows to the next remaining main tool (see `_reflowActive`).
  panel: DevtoolsPanel;
  // User-arrangeable tool tabs: each tool lives in the main bar or the bottom
  // drawer (§drawer). Persisted to localStorage; Console defaults to the drawer.
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

type DevtoolsActions = {
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
  | 'navStartTime'
  | 'domContentTime'
  | 'loadTime'
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
    navStartTime: null,
    domContentTime: null,
    loadTime: null,
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
      if (groupForTab(useGridStore.getState().groups, useTabsStore.getState().activeTabId) !== null) {
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
        title: 'Added to context',
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
        // Page-lifecycle timing for the Network summary bar (CDP seconds).
        let navStart = s.navStartTime;
        let domContent = s.domContentTime;
        let load = s.loadTime;

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
            case 'Page.domContentEventFired': {
              domContent = pAny.timestamp as number;
              break;
            }
            case 'Page.loadEventFired': {
              load = pAny.timestamp as number;
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
              // First request of the document is the navigation baseline the
              // waterfall + DOMContentLoaded/Load offsets are measured against.
              if (navStart === null) navStart = entry.startTime;
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
        if (navStart !== s.navStartTime) next.navStartTime = navStart;
        if (domContent !== s.domContentTime) next.domContentTime = domContent;
        if (load !== s.loadTime) next.loadTime = load;
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
