/**
 * Normalized runtime-error evidence — the shape the assist loop (P0 "Fix this")
 * and a future agent `get_console_errors` tool both consume (roadmap §9). Pure:
 * no CDP/Electron/DOM imports, so the extraction is unit-testable and shared
 * between main (always-on capture in electron/browser/cdp.ts) and the renderer.
 *
 * `extractConsoleError` turns a raw CDP `Runtime.exceptionThrown` or
 * `Runtime.consoleAPICalled(type:'error'|'assert')` message into one record, or
 * null otherwise. (Network/resource `Log.entryAdded` errors are P0.5 triage, so
 * P0 stays focused on JS errors.) It is deliberately defensive about its
 * `unknown` params — page-originated data must never crash the relay.
 */

/** One stack frame, the subset we surface (mirrors CDP `Runtime.CallFrame`). */
export type StackFrameLite = {
  functionName: string;
  url: string;
  /** 0-based, as CDP reports. */
  lineNumber: number;
  columnNumber: number;
};

/** Where a captured error came from (drives wording, not behaviour). */
export type ErrorOrigin = 'exception' | 'console.error' | 'log';

/** A captured runtime error: message + stack + the location it points at. */
export type ConsoleErrorEvidence = {
  /** Unique per capture (renderer list keys / map order). Not stable across reloads. */
  id: string;
  origin: ErrorOrigin;
  /** The error text (exception message / joined console args / log text). */
  message: string;
  /** Innermost-first call frames, when CDP provided a stack. */
  stack: StackFrameLite[];
  /** Top-of-stack / `exceptionDetails` location, when available. */
  source?: { url: string; lineNumber?: number };
  /** Event timestamp (ms since epoch) or capture time. */
  timestamp: number;
};

/** Console severity for the agent's all-level `read_console` (vs error-only evidence). */
export type ConsoleLevel = 'log' | 'info' | 'warning' | 'error' | 'debug';

/**
 * One captured console.* message at ANY level — what feeds the agent's
 * `read_console` tool (electron/browser/state.ts consoleBuffers). Unlike
 * {@link ConsoleErrorEvidence} (errors only, with source mapping for "fix this"),
 * this keeps every level so the agent can see what the running app actually logged.
 */
export type ConsoleMessage = {
  id: string;
  level: ConsoleLevel;
  /** Raw CDP console type (log/warning/error/info/debug/trace/dir/table/…). */
  type: string;
  /** Joined, bounded args text. */
  text: string;
  /** Top stack frame location, when CDP provided one. */
  source?: { url: string; lineNumber?: number };
  timestamp: number;
};

const MAX_MESSAGE = 1000;

let seq = 0;
function evidenceId(): string {
  return `cerr-${Date.now().toString(36)}-${++seq}`;
}

function firstLine(text: string): string {
  const nl = text.indexOf('\n');
  const line = nl === -1 ? text : text.slice(0, nl);
  return line.length > MAX_MESSAGE ? line.slice(0, MAX_MESSAGE) + '…' : line;
}

/** A CDP `RemoteObject` → a short readable string (for console.error args). */
function remoteObjectText(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') return String(obj);
  const o = obj as Record<string, unknown>;
  if (o.value !== undefined) return String(o.value);
  if (typeof o.unserializableValue === 'string') return o.unserializableValue;
  if (typeof o.description === 'string') return o.description;
  if (typeof o.className === 'string') return o.className;
  return typeof o.type === 'string' ? o.type : '';
}

type RawFrame = {
  functionName?: unknown;
  url?: unknown;
  lineNumber?: unknown;
  columnNumber?: unknown;
};

function toStack(stackTrace: unknown): StackFrameLite[] {
  if (!stackTrace || typeof stackTrace !== 'object') return [];
  const frames = (stackTrace as { callFrames?: unknown }).callFrames;
  if (!Array.isArray(frames)) return [];
  const out: StackFrameLite[] = [];
  for (const f of frames as RawFrame[]) {
    out.push({
      functionName: typeof f.functionName === 'string' ? f.functionName : '',
      url: typeof f.url === 'string' ? f.url : '',
      lineNumber: typeof f.lineNumber === 'number' ? f.lineNumber : 0,
      columnNumber: typeof f.columnNumber === 'number' ? f.columnNumber : 0,
    });
  }
  return out;
}

/** Top frame with a real URL → the error's source location. */
function topSource(
  stack: StackFrameLite[],
  fallbackUrl?: unknown,
  fallbackLine?: unknown,
): ConsoleErrorEvidence['source'] {
  const frame = stack.find((f) => f.url);
  if (frame) return { url: frame.url, lineNumber: frame.lineNumber };
  if (typeof fallbackUrl === 'string' && fallbackUrl) {
    return {
      url: fallbackUrl,
      lineNumber: typeof fallbackLine === 'number' ? fallbackLine : undefined,
    };
  }
  return undefined;
}

/**
 * Normalize a CDP error-bearing message into evidence, or null. P0 recognizes
 * JS errors only:
 *  - `Runtime.exceptionThrown`             (uncaught errors / `throw`)
 *  - `Runtime.consoleAPICalled` type=error (and `assert`)
 * `Log.entryAdded` (network / resource / security) is deferred to P0.5 triage.
 */
export function extractConsoleError(
  method: string,
  params: unknown,
): ConsoleErrorEvidence | null {
  const p = (params ?? {}) as Record<string, unknown>;

  if (method === 'Runtime.exceptionThrown') {
    const det = (p.exceptionDetails ?? {}) as Record<string, unknown>;
    const exc = det.exception as Record<string, unknown> | undefined;
    const desc =
      (exc && typeof exc.description === 'string' && exc.description) ||
      (exc && exc.value !== undefined ? String(exc.value) : '') ||
      (typeof det.text === 'string' ? det.text : '') ||
      'Uncaught (unknown error)';
    const stack = toStack(det.stackTrace);
    return {
      id: evidenceId(),
      origin: 'exception',
      message: firstLine(desc),
      stack,
      source: topSource(stack, det.url, det.lineNumber),
      timestamp: typeof p.timestamp === 'number' ? p.timestamp : Date.now(),
    };
  }

  if (method === 'Runtime.consoleAPICalled') {
    const type = p.type;
    if (type !== 'error' && type !== 'assert') return null;
    const args = Array.isArray(p.args) ? p.args : [];
    const message = args.map(remoteObjectText).filter(Boolean).join(' ').trim();
    const stack = toStack(p.stackTrace);
    return {
      id: evidenceId(),
      origin: 'console.error',
      message: firstLine(message || 'console.error'),
      stack,
      source: topSource(stack),
      timestamp: typeof p.timestamp === 'number' ? p.timestamp : Date.now(),
    };
  }

  return null;
}

const MAX_CONSOLE_TEXT = 2000;
let cseq = 0;
function consoleId(): string {
  return `cmsg-${Date.now().toString(36)}-${++cseq}`;
}

/** CDP console `type` → coarse {@link ConsoleLevel}. */
function consoleLevel(type: string): ConsoleLevel {
  switch (type) {
    case 'error':
    case 'assert':
      return 'error';
    case 'warning':
      return 'warning';
    case 'info':
      return 'info';
    case 'debug':
    case 'verbose':
      return 'debug';
    default:
      return 'log';
  }
}

/**
 * Normalize a CDP `Runtime.consoleAPICalled` (ANY type) into a {@link ConsoleMessage},
 * or null for other methods. The all-level twin of {@link extractConsoleError}
 * (which keeps only errors): both run on the same always-on Runtime stream, so a
 * console.error lands in both rings — the error ring (with source mapping) and
 * here (as a plain message). Defensive about `unknown` params like its twin.
 */
export function extractConsoleMessage(method: string, params: unknown): ConsoleMessage | null {
  if (method !== 'Runtime.consoleAPICalled') return null;
  const p = (params ?? {}) as Record<string, unknown>;
  const type = typeof p.type === 'string' ? p.type : 'log';
  const args = Array.isArray(p.args) ? p.args : [];
  let text = args.map(remoteObjectText).filter(Boolean).join(' ').trim();
  if (text.length > MAX_CONSOLE_TEXT) text = text.slice(0, MAX_CONSOLE_TEXT) + '…';
  const stack = toStack(p.stackTrace);
  const top = stack.find((f) => f.url);
  return {
    id: consoleId(),
    level: consoleLevel(type),
    type,
    text: text || `console.${type}`,
    source: top ? { url: top.url, lineNumber: top.lineNumber } : undefined,
    timestamp: typeof p.timestamp === 'number' ? p.timestamp : Date.now(),
  };
}

/**
 * Map a runtime URL to a workspace-relative source path, or null. The main-side
 * twin of {@link resolveStyleSheetSource} (css-source.ts): a same-origin URL
 * whose pathname mirrors a workspace file — i.e. the open workspace's dev server
 * (Vite) or a static server serving real files. The patch layer's fs-safe
 * resolver + existence check downstream is the authoritative gate; this only
 * bails early on obviously non-file / cross-origin URLs.
 */
export function urlToWorkspacePath(url: string, origin: string): string | null {
  if (!url || !origin) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.origin !== origin) return null; // only the inspected app's own files
  let p: string;
  try {
    p = decodeURIComponent(u.pathname);
  } catch {
    return null;
  }
  if (p.startsWith('/')) p = p.slice(1);
  if (!p || p.endsWith('/') || p.includes('..')) return null;
  return p;
}
