/**
 * The slice of the Chrome DevTools Protocol our panels consume. These mirror the
 * CDP wire shapes (https://chromedevtools.github.io/devtools-protocol/) but only
 * the fields we read — the relay in electron/browser/cdp.ts forwards raw CDP, so
 * what crosses `devtools:cdp-event` / the `cdp-send` result is typed here, not in
 * the shared IPC contract (it's renderer-only domain knowledge).
 */

/* ── DOM ──────────────────────────────────────────────────────────────── */

export type NodeId = number;
export type BackendNodeId = number;

/** A DOM node as returned by `DOM.getDocument` / `DOM.requestChildNodes`. */
export type CdpNode = {
  nodeId: NodeId;
  parentId?: NodeId;
  backendNodeId?: BackendNodeId;
  /** 1 element · 3 text · 8 comment · 9 document · 10 doctype · 11 fragment. */
  nodeType: number;
  nodeName: string;
  localName: string;
  nodeValue: string;
  childNodeCount?: number;
  children?: CdpNode[];
  /** Flat `[name, value, name, value, …]` for element attributes. */
  attributes?: string[];
  /** A single pseudo-element marker (`::before`), present on pseudo nodes. */
  pseudoType?: string;
  contentDocument?: CdpNode;
};

export const NODE_TYPE = {
  ELEMENT: 1,
  TEXT: 3,
  COMMENT: 8,
  DOCUMENT: 9,
  DOCTYPE: 10,
  FRAGMENT: 11,
} as const;

/**
 * `DOM.BoxModel` (subset). Each quad is `[x1,y1,x2,y2,x3,y3,x4,y4]`; nesting is
 * margin ⊃ border ⊃ padding ⊃ content. `width`/`height` are the content box.
 */
export type BoxModel = {
  content: number[];
  padding: number[];
  border: number[];
  margin: number[];
  width: number;
  height: number;
};

/* ── CSS ──────────────────────────────────────────────────────────────── */

export type CssSourceRange = {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
};

export type CssProperty = {
  name: string;
  value: string;
  important?: boolean;
  disabled?: boolean;
  text?: string;
  range?: CssSourceRange;
};

export type CssStyle = {
  styleSheetId?: string;
  cssProperties: CssProperty[];
  shorthandEntries: { name: string; value: string }[];
  cssText?: string;
  range?: CssSourceRange;
};

export type CssRule = {
  selectorList: { selectors: { text: string }[]; text: string };
  origin: string;
  style: CssStyle;
};

export type RuleMatch = { rule: CssRule; matchingSelectors: number[] };

/** `CSS.getMatchedStylesForNode` (the subset Elements renders). */
export type MatchedStyles = {
  inlineStyle?: CssStyle;
  attributesStyle?: CssStyle;
  matchedCSSRules?: RuleMatch[];
};

export type ComputedStyleProperty = { name: string; value: string };

/**
 * The slice of `CSS.styleSheetAdded`'s header we keep, to map an edited rule
 * back to its origin for the live-CSS → workspace-patch hook (§9-B). `origin`
 * is `'regular' | 'user-agent' | 'inspector' | 'injected'`; only `'regular'`
 * author sheets are candidates for source patching.
 */
export type StyleSheetHeader = {
  styleSheetId: string;
  sourceURL: string;
  origin: string;
  isInline: boolean;
};

/* ── Runtime / Console ────────────────────────────────────────────────── */

export type RemoteObject = {
  type: string;
  subtype?: string;
  className?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  objectId?: string;
  preview?: ObjectPreview;
};

export type PropertyPreview = {
  name: string;
  type: string;
  value?: string;
  subtype?: string;
};

export type ObjectPreview = {
  type: string;
  subtype?: string;
  description?: string;
  overflow: boolean;
  properties: PropertyPreview[];
};

export type PropertyDescriptor = {
  name: string;
  value?: RemoteObject;
  get?: RemoteObject;
  set?: RemoteObject;
  enumerable: boolean;
  isOwn?: boolean;
};

export type StackFrame = {
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
};

export type CdpStackTrace = {
  description?: string;
  callFrames: StackFrame[];
};

/** The kind drives the row's icon/colour in the console. */
export type ConsoleKind =
  | 'log'
  | 'info'
  | 'warning'
  | 'error'
  | 'debug'
  | 'command'
  | 'result'
  | 'exception';

export type ConsoleEntry = {
  id: string;
  kind: ConsoleKind;
  args: RemoteObject[];
  /** Pre-rendered text for command echoes / plain string entries. */
  text?: string;
  timestamp: number;
  stackTrace?: CdpStackTrace;
  url?: string;
  lineNumber?: number;
};

/* ── Network ──────────────────────────────────────────────────────────── */

/**
 * `Network.ResourceTiming` (subset). All offsets are milliseconds relative to
 * `requestTime` (seconds, CDP monotonic). `-1` means the phase didn't occur.
 */
export type ResourceTiming = {
  requestTime: number;
  dnsStart: number;
  dnsEnd: number;
  connectStart: number;
  connectEnd: number;
  sslStart: number;
  sslEnd: number;
  sendStart: number;
  sendEnd: number;
  receiveHeadersEnd: number;
};

/** `Network.Initiator` (subset) — who kicked off the request. */
export type NetworkInitiator = {
  type: string;
  url?: string;
  lineNumber?: number;
  stack?: CdpStackTrace;
};

export type NetworkEntry = {
  requestId: string;
  url: string;
  method: string;
  resourceType?: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  fromCache?: boolean;
  /** CDP monotonic timestamps (seconds). */
  startTime: number;
  /**
   * Wall-clock send time in epoch ms (from `requestWillBeSent.wallTime`, seconds
   * → ms). The monotonic `startTime` has an arbitrary origin, so this is the only
   * field comparable with the console's wall-clock `timestamp` — used to order
   * the runtime evidence timeline across sources.
   */
  wallTime?: number;
  endTime?: number;
  encodedDataLength?: number;
  failed?: boolean;
  errorText?: string;
  requestHeaders?: Record<string, string>;
  requestPostData?: string;
  requestPostDataTruncated?: boolean;
  responseHeaders?: Record<string, string>;
  remoteIPAddress?: string;
  /** Per-phase timing from the response (for the detail waterfall). */
  timing?: ResourceTiming;
  /** What initiated the request (parser / script / preload …). */
  initiator?: NetworkInitiator;
  /** True for rows created by `Network.webSocketCreated` (type "WS"). */
  isWebSocket?: boolean;
  /** Captured WebSocket frames, oldest-first, capped — see framesDropped. */
  frames?: WsFrame[];
  /** Frames evicted from the front of `frames` once past the cap. */
  framesDropped?: number;
  /** `Network.eventSourceMessageReceived` messages for this stream, capped. */
  sseMessages?: SseMessage[];
  /** SSE messages evicted from the front of `sseMessages` once past the cap. */
  sseDropped?: number;
};

/* ── Debugger (Sources) ───────────────────────────────────────────────── */

/** `Debugger.scriptParsed` (subset) — one parsed script with a real URL. */
export type ScriptInfo = {
  scriptId: string;
  url: string;
  /** From scriptParsed; inline `data:` or a (possibly relative) `.map` URL. */
  sourceMapURL?: string;
  /** From scriptParsed's executionContextAuxData — for Network.loadNetworkResource. */
  frameId?: string;
};

/** `Debugger.Location` — line/column inside a script (0-based). */
export type DebuggerLocation = {
  scriptId: string;
  lineNumber: number;
  columnNumber?: number;
};

/** One entry of a paused call frame's scope chain (`Debugger.Scope`). */
export type DebuggerScope = {
  /** 'global' | 'local' | 'closure' | 'block' | 'with' | 'catch' | 'module' … */
  type: string;
  /** The scope's variables as a RemoteObject (expand via Runtime.getProperties). */
  object: RemoteObject;
  name?: string;
};

/** `Debugger.CallFrame` (subset) from a `Debugger.paused` event. */
export type DebuggerCallFrame = {
  callFrameId: string;
  functionName: string;
  url: string;
  location: DebuggerLocation;
  scopeChain: DebuggerScope[];
};

/**
 * A user breakpoint, keyed by url:line so it survives reloads (CDP's
 * setBreakpointByUrl is URL-keyed server-side too). `id` is the live CDP
 * breakpoint id for the CURRENT debugger session — re-setting on a fresh
 * attach refreshes it (see `_applySources`).
 */
export type SourceBreakpoint = {
  id: string | null;
  url: string;
  lineNumber: number;
  /** Generated column the line maps from (original-mode breakpoints). */
  columnNumber?: number;
  /** When set from the original-source view: the mapped original url:line the
   *  marker/list display (the CDP breakpoint itself lives at url:lineNumber). */
  original?: { url: string; lineNumber: number };
};

/** `Debugger.setPauseOnExceptions` state. */
export type PauseOnExceptions = 'none' | 'uncaught' | 'all';

/** The pause snapshot while the page is stopped at a breakpoint/exception. */
export type PausedInfo = {
  reason: string;
  callFrames: DebuggerCallFrame[];
  /** The call-stack frame the viewer/scope pane currently shows. */
  frameIndex: number;
  /** Reason-specific auxiliary data (XHR url, event name, exception object…). */
  data?: Record<string, unknown>;
};

/* ── Profiler / Performance ───────────────────────────────────────────── */

/** The `Runtime.CallFrame` embedded in a profile node (subset). */
export type ProfileCallFrame = {
  functionName: string;
  url: string;
  /** 0-based; -1 when unknown. */
  lineNumber: number;
};

/** `Profiler.ProfileNode` (subset) — `children` are node ids. */
export type CdpProfileNode = {
  id: number;
  callFrame: ProfileCallFrame;
  hitCount?: number;
  children?: number[];
};

/**
 * `Profiler.Profile` as returned by `Profiler.stop`. Times are microseconds:
 * `samples[i]` is the node id observed at sample i, `timeDeltas[i]` the interval
 * before it (the first delta is relative to `startTime`).
 */
export type CdpProfile = {
  nodes: CdpProfileNode[];
  startTime: number;
  endTime: number;
  samples?: number[];
  timeDeltas?: number[];
};

/** One `Performance.getMetrics` metric (counts, bytes, or seconds by name). */
export type PerfMetric = { name: string; value: number };

/* ── Security ─────────────────────────────────────────────────────────── */

/** `Security.SecurityState` — the page's overall security verdict. */
export type SecurityState =
  | 'unknown'
  | 'neutral'
  | 'insecure'
  | 'secure'
  | 'info'
  | 'insecure-broken';

/** `Security.CertificateSecurityState` (subset the panel renders). */
export type CertificateSecurityState = {
  protocol: string;
  keyExchange: string;
  keyExchangeGroup?: string;
  cipher: string;
  subjectName: string;
  issuer: string;
  /** Seconds since epoch. */
  validFrom: number;
  validTo: number;
};

/**
 * The normalized `Security.visibleSecurityStateChanged` snapshot (modern event;
 * the deprecated securityStateChanged explanations are replaced by issue ids).
 */
export type VisibleSecurityState = {
  securityState: SecurityState;
  certificate?: CertificateSecurityState;
  /** `securityStateIssueIds` — e.g. 'displayed-mixed-content'. */
  issueIds: string[];
};

/* ── Application (storage) ────────────────────────────────────────────── */

/** One object store of an IndexedDB database (`IndexedDB.ObjectStore` subset). */
export type IdbObjectStore = {
  name: string;
  /** Display form of the key path ('' when the store uses out-of-line keys). */
  keyPath: string;
  autoIncrement: boolean;
};

/** `IndexedDB.DatabaseWithObjectStores` (subset). */
export type IdbDatabase = {
  name: string;
  version: number;
  objectStores: IdbObjectStore[];
};

/** One `IndexedDB.requestData` entry — key/value arrive as RemoteObjects. */
export type IdbEntry = {
  key: RemoteObject;
  primaryKey: RemoteObject;
  value: RemoteObject;
};

/** `CacheStorage.Cache` — one cache of the origin's CacheStorage. */
export type CacheInfo = {
  cacheId: string;
  securityOrigin: string;
  cacheName: string;
};

/** `CacheStorage.DataEntry` (subset) for the entries table. */
export type CacheEntry = {
  requestURL: string;
  requestMethod: string;
  responseStatus: number;
  responseStatusText: string;
  /** Seconds since epoch. */
  responseTime?: number;
};

/** `Network.Cookie` (subset) for the Application panel's read-only table. */
export type CdpCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Unix seconds; -1 / absent = session cookie. */
  expires?: number;
  size?: number;
  httpOnly?: boolean;
  secure?: boolean;
  session?: boolean;
  sameSite?: string;
};

/* ── Coverage (Profiler / CSS rule usage) ─────────────────────────────── */

/** One `Profiler.CoverageRange` — byte offsets into the script source. */
export type ProfilerCoverageRange = {
  startOffset: number;
  endOffset: number;
  /** Execution count (0 with `callCount: false` still means "not executed"). */
  count: number;
};

/** `Profiler.FunctionCoverage` (subset) from `Profiler.takePreciseCoverage`. */
export type ProfilerFunctionCoverage = {
  functionName: string;
  ranges: ProfilerCoverageRange[];
  isBlockCoverage: boolean;
};

/** `Profiler.ScriptCoverage` — per-script coverage entries. */
export type ProfilerScriptCoverage = {
  scriptId: string;
  url: string;
  functions: ProfilerFunctionCoverage[];
};

/** One `CSS.RuleUsage` entry from `CSS.stopRuleUsageTracking`. */
export type CssRuleUsage = {
  styleSheetId: string;
  startOffset: number;
  endOffset: number;
  used: boolean;
};

/* ── Network: WebSocket frames + SSE messages ─────────────────────────── */

/** `'error'` rows come from `Network.webSocketFrameError` (no direction). */
export type WsFrameDirection = 'sent' | 'received' | 'error';

/** One captured WebSocket frame (`Network.webSocketFrameSent/Received`). */
export type WsFrame = {
  direction: WsFrameDirection;
  /** CDP monotonic seconds — same clock as `NetworkEntry.startTime`. */
  timestamp: number;
  /** WebSocket opcode: 1 text · 2 binary · 8 close · 9 ping · 10 pong. -1 for error rows. */
  opcode: number;
  /** Text payload for text frames; the error message for error rows. Bounded. */
  payloadData: string;
  payloadTruncated?: boolean;
  /** Decoded byte size for binary frames (the payload itself is not stored). */
  payloadBytes?: number;
};

/** One `Network.eventSourceMessageReceived` message of an SSE stream. */
export type SseMessage = {
  eventName: string;
  /** The stream's `lastEventId` ('' when the server sent none). */
  eventId: string;
  data: string;
  dataTruncated?: boolean;
  /** CDP monotonic seconds — same clock as `NetworkEntry.startTime`. */
  timestamp: number;
};

/* ── Application: quota / manifest / frames / service workers ─────────── */

/** One `Storage.getUsageAndQuota` usageBreakdown entry. */
export type StorageUsageBreakdown = { storageType: string; usage: number };

/** `Storage.getUsageAndQuota` for the page origin (bytes). */
export type StorageUsage = {
  usage: number;
  quota: number;
  breakdown: StorageUsageBreakdown[];
};

/** One `Page.getAppManifest` parse error. */
export type AppManifestError = {
  message: string;
  critical: boolean;
  line: number;
  column: number;
};

/** `Page.getAppManifest` (subset). `data` is the raw manifest text. */
export type AppManifest = {
  url: string;
  errors: AppManifestError[];
  data?: string;
};

/** One frame of `Page.getFrameTree`, flattened with its tree depth. */
export type FrameTreeNode = {
  id: string;
  url: string;
  name?: string;
  mimeType?: string;
  depth: number;
};

/** `ServiceWorker.workerRegistrationUpdated` registration (subset). */
export type SwRegistration = {
  registrationId: string;
  scopeURL: string;
  isDeleted: boolean;
};

/** `ServiceWorker.workerVersionUpdated` version (subset). */
export type SwVersion = {
  versionId: string;
  registrationId: string;
  scriptURL: string;
  /** 'stopped' | 'starting' | 'running' | 'stopping'. */
  runningStatus: string;
  /** 'new' | 'installing' | 'installed' | 'activating' | 'activated' | 'redundant'. */
  status: string;
};

/* ── Elements: event listeners / accessibility / fonts ────────────────── */

/** `DOMDebugger.EventListener` (subset the Event Listeners pane renders). */
export type EventListenerInfo = {
  type: string;
  useCapture: boolean;
  passive: boolean;
  once: boolean;
  scriptId: string;
  /** 0-based location of the handler inside its script. */
  lineNumber: number;
  columnNumber: number;
  /** The listener's backing function (its `description` is the preview). */
  handler?: RemoteObject;
};

/** `Accessibility.AXValue` (subset) — a typed value of an AX attribute. */
export type AXValue = {
  type: string;
  value?: unknown;
};

/** One `Accessibility.AXProperty` (checked / disabled / level / …). */
export type AXProperty = {
  name: string;
  value: AXValue;
};

/** `Accessibility.AXNode` (subset the Accessibility pane renders). */
export type AXNode = {
  nodeId: string;
  ignored: boolean;
  ignoredReasons?: AXProperty[];
  role?: AXValue;
  name?: AXValue;
  description?: AXValue;
  properties?: AXProperty[];
};

/** `CSS.getBackgroundColors` result — page colors behind the node (contrast). */
export type BackgroundColorsInfo = {
  /** CSS color strings; absent when the background can't be determined. */
  backgroundColors?: string[];
  computedFontSize?: string;
  computedFontWeight?: string;
};

/** `CSS.PlatformFontUsage` — one font actually rendering the node's text. */
export type PlatformFontUsage = {
  familyName: string;
  postScriptName?: string;
  isCustomFont: boolean;
  glyphCount: number;
};

/* ── DOMDebugger breakpoints + Watch (Sources sidebar) ────────────────── */

/**
 * One XHR/fetch breakpoint (`DOMDebugger.setXHRBreakpoint`). `url` is a
 * substring filter; the empty string breaks on ANY XHR/fetch. Sticky across
 * navigations/re-attach like url:line breakpoints (re-armed in _applySources).
 */
export type XhrBreakpoint = {
  url: string;
  enabled: boolean;
};

/** One watch expression's last evaluation. Errors render muted, never throw. */
export type WatchResult = {
  value?: RemoteObject;
  error?: string;
};

/** `Runtime.evaluate` / `Debugger.evaluateOnCallFrame` result (subset). */
export type CdpEvalResult = {
  result: RemoteObject;
  exceptionDetails?: {
    text: string;
    exception?: RemoteObject;
  };
};
