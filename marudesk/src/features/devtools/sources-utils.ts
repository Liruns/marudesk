import type { ScriptInfo } from './types';

/**
 * Pure helpers for the Sources panel: script-URL filtering/labelling and the
 * origin-grouped sidebar tree. No CDP and no store access so they stay cheap to
 * unit-test (see sources-utils.test.ts).
 */

/**
 * Scripts the sidebar should never list: extension/devtools internals and
 * Chromium-injected helpers. Inline `eval` scripts (no url at all) are already
 * dropped at ingest time.
 */
export function isInternalScriptUrl(url: string): boolean {
  return (
    url.startsWith('chrome-extension://') ||
    url.startsWith('extensions::') ||
    url.startsWith('devtools://') ||
    url.startsWith('chrome://') ||
    // Electron preload/internal modules.
    url.startsWith('node:') ||
    url.startsWith('electron/')
  );
}

/** The display label for a script: its file name (path tail), else the URL. */
export function scriptLabel(url: string): string {
  try {
    const u = new URL(url);
    const tail = u.pathname.split('/').filter(Boolean).pop();
    if (tail) return u.search ? `${tail}${u.search}` : tail;
    // Origin root (e.g. an inline document script attributed to the page URL).
    return u.host || url;
  } catch {
    const tail = url.split('/').filter(Boolean).pop();
    return tail || url;
  }
}

/** The grouping key for the sidebar: the script URL's origin. */
export function scriptOrigin(url: string): string {
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? '(no origin)' : origin;
  } catch {
    return '(no origin)';
  }
}

export type ScriptGroup = { origin: string; scripts: ScriptInfo[] };

/**
 * Group scripts by origin for the sidebar, filtered by a case-insensitive
 * substring on the URL. Groups and the scripts within each are sorted by name
 * so the tree is stable as scripts stream in.
 */
export function groupScriptsByOrigin(
  scripts: Iterable<ScriptInfo>,
  filter: string,
): ScriptGroup[] {
  const q = filter.trim().toLowerCase();
  const byOrigin = new Map<string, ScriptInfo[]>();
  for (const s of scripts) {
    if (q && !s.url.toLowerCase().includes(q)) continue;
    const origin = scriptOrigin(s.url);
    const list = byOrigin.get(origin);
    if (list) list.push(s);
    else byOrigin.set(origin, [s]);
  }
  const groups: ScriptGroup[] = [...byOrigin.entries()].map(([origin, list]) => ({
    origin,
    scripts: list.sort((a, b) => a.url.localeCompare(b.url)),
  }));
  return groups.sort((a, b) => a.origin.localeCompare(b.origin));
}

/**
 * Human label for a `Debugger.paused` reason + its auxiliary data, for the
 * paused banner ("Paused on …"). Null for the plain 'other' reason (regular
 * breakpoints/steps), where the banner shows just "Paused".
 */
export function pausedReasonLabel(
  reason: string,
  data: Record<string, unknown> | undefined,
): string | null {
  if (reason === 'XHR') {
    const url = typeof data?.url === 'string' ? data.url : '';
    return url ? `XHR/fetch breakpoint "${url}"` : 'XHR/fetch breakpoint';
  }
  if (reason === 'EventListener') {
    const raw = typeof data?.eventName === 'string' ? data.eventName : '';
    // The backend reports the breakpoint name with its category prefix
    // (e.g. 'listener:click') even though it's armed with the plain name.
    const name = raw.startsWith('listener:') ? raw.slice('listener:'.length) : raw;
    return name ? `"${name}" event listener breakpoint` : 'event listener breakpoint';
  }
  if (reason === 'exception' || reason === 'promiseRejection') {
    const base = reason === 'exception' ? 'exception' : 'promise rejection';
    // For these reasons `data` is the exception RemoteObject itself.
    const desc = typeof data?.description === 'string' ? data.description : '';
    const first = desc.split('\n', 1)[0];
    return first ? `${base}: ${first}` : base;
  }
  if (reason === 'debugCommand') return 'debugger statement';
  if (reason === 'DOM') return 'DOM breakpoint';
  if (reason === 'assert') return 'assertion';
  if (reason === 'OOM') return 'out of memory';
  return reason && reason !== 'other' ? reason : null;
}
