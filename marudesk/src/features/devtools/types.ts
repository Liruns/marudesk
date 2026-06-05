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
};

/* ── Application (storage) ────────────────────────────────────────────── */

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
