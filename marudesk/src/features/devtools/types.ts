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
  responseHeaders?: Record<string, string>;
  remoteIPAddress?: string;
};
