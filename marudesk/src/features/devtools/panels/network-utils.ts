import type { TranslationKey } from '../../../i18n/messages';
import type { ThrottlePreset } from '../store';
import type { NetworkEntry } from '../types';

/**
 * Pure formatting/derivation helpers and filter data for the Network panel,
 * pulled out of the component so the panel file holds rendering only. Nothing
 * here touches React or the store — every function maps a request entry (or
 * primitive) to a string/boolean/number.
 */

export function fileName(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    return (last || u.hostname) + (u.search ? u.search : '');
  } catch {
    return url;
  }
}

/** Filter-bar resource-type buckets → the CDP resourceType values each admits. */
export type TypeFilter = 'all' | 'fetch' | 'js' | 'css' | 'img' | 'font' | 'doc' | 'media' | 'other';

export const TYPE_FILTERS: { id: TypeFilter; labelKey: TranslationKey }[] = [
  { id: 'all', labelKey: 'devtools.network.filter.all' },
  { id: 'fetch', labelKey: 'devtools.network.filter.fetch' },
  { id: 'js', labelKey: 'devtools.network.filter.js' },
  { id: 'css', labelKey: 'devtools.network.filter.css' },
  { id: 'img', labelKey: 'devtools.network.filter.img' },
  { id: 'font', labelKey: 'devtools.network.filter.font' },
  { id: 'doc', labelKey: 'devtools.network.filter.doc' },
  { id: 'media', labelKey: 'devtools.network.filter.media' },
  { id: 'other', labelKey: 'devtools.network.filter.other' },
];

export const KNOWN_TYPES = new Set(['fetch', 'js', 'css', 'img', 'font', 'doc', 'media']);

/** Map a CDP resourceType to its filter bucket. */
export function typeBucket(resourceType: string | undefined): Exclude<TypeFilter, 'all'> {
  switch (resourceType) {
    case 'XHR':
    case 'Fetch':
    case 'EventSource':
      return 'fetch';
    case 'Script':
      return 'js';
    case 'Stylesheet':
      return 'css';
    case 'Image':
      return 'img';
    case 'Font':
      return 'font';
    case 'Document':
      return 'doc';
    case 'Media':
      return 'media';
    default:
      return 'other';
  }
}

export const THROTTLE_OPTIONS: { id: ThrottlePreset; labelKey: TranslationKey }[] = [
  { id: 'online', labelKey: 'devtools.network.throttle.none' },
  { id: 'fast3g', labelKey: 'devtools.network.throttle.fast3g' },
  { id: 'slow3g', labelKey: 'devtools.network.throttle.slow3g' },
  { id: 'offline', labelKey: 'devtools.network.throttle.offline' },
];

/**
 * Build a `curl` command line for a request from its method/url/headers
 * (client-side; the request body isn't captured). Single-quotes are escaped for
 * a POSIX shell. Display/copy only — not executed.
 */
export function buildCurl(entry: NetworkEntry): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const parts = [`curl ${q(entry.url)}`];
  if (entry.method && entry.method !== 'GET') parts.push(`-X ${entry.method}`);
  for (const [k, v] of Object.entries(entry.requestHeaders ?? {})) {
    // Skip pseudo-headers (HTTP/2 `:method`, `:path`, …) — not valid curl -H.
    if (k.startsWith(':')) continue;
    parts.push(`-H ${q(`${k}: ${v}`)}`);
  }
  return parts.join(' \\\n  ');
}

/** A request worth handing to the agent: a transport failure or a 4xx/5xx response. */
export function isFailure(entry: NetworkEntry): boolean {
  return entry.failed === true || (entry.status !== undefined && entry.status >= 400);
}

/**
 * Seed an agent turn with the one failed request's identity (method/url/status)
 * so it targets the right entry, then hand off to its own `read_network` /
 * `read_network_body` tools to pull headers + body and find the root cause —
 * mirroring the console "Fix this" flow (which leans on `get_console_errors`).
 */
export function buildNetworkFixPrompt(entry: NetworkEntry): string {
  const outcome = entry.failed
    ? `failed at the transport level${entry.errorText ? ` (${entry.errorText})` : ''}`
    : `returned ${entry.status ?? '?'}${entry.statusText ? ` ${entry.statusText}` : ''}`;
  return (
    `A network request on the running page is broken and needs fixing.\n` +
    `  ${entry.method ?? 'GET'} ${entry.url}\n` +
    `  Outcome: ${outcome}\n\n` +
    `Use read_network (and read_network_body for this request) to inspect the ` +
    `actual response/headers, find the root cause in the workspace source — the ` +
    `client call site or the server/handler — fix it, then reload and verify the ` +
    `request succeeds.`
  );
}

export function fmtSize(entry: NetworkEntry): string {
  if (entry.fromCache) return '(cache)';
  const n = entry.encodedDataLength;
  if (n === undefined) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function fmtTime(entry: NetworkEntry): string {
  if (entry.endTime === undefined) return '…';
  return fmtMs((entry.endTime - entry.startTime) * 1000);
}

/** A duration in ms → a compact `ms`/`s` label (shared by Time + the summary). */
export function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Pretty-print a JSON response body so an API payload reads as a tree instead of
 * one wrapped line. Falls back to the raw text when the body isn't JSON (the
 * mime hint is advisory — some servers send JSON as text/plain, so we also try
 * to parse anything that looks like an object/array).
 */
export function prettyBody(body: string, mime?: string): string {
  const looksJson =
    (mime && /json/i.test(mime)) || /^\s*[[{]/.test(body);
  if (!looksJson) return body;
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

export function headerValue(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/** Aggregate footer stats for the request table (DevTools' summary bar). */
export function summarize(
  entries: NetworkEntry[],
  navStart: number | null,
  domContent: number | null,
  load: number | null,
): { count: number; transferred: number; finish: number | null; dcl: number | null; loaded: number | null } {
  let transferred = 0;
  let minStart = Infinity;
  let maxEnd = -Infinity;
  for (const e of entries) {
    if (!e.fromCache && e.encodedDataLength) transferred += e.encodedDataLength;
    if (e.startTime < minStart) minStart = e.startTime;
    if (e.endTime !== undefined && e.endTime > maxEnd) maxEnd = e.endTime;
  }
  const base = navStart ?? (minStart === Infinity ? null : minStart);
  return {
    count: entries.length,
    transferred,
    finish: maxEnd > -Infinity && minStart < Infinity ? (maxEnd - minStart) * 1000 : null,
    dcl: base !== null && domContent !== null ? (domContent - base) * 1000 : null,
    loaded: base !== null && load !== null ? (load - base) * 1000 : null,
  };
}

export function statusClass(entry: NetworkEntry): string {
  if (entry.failed) return 'text-error';
  if (entry.status === undefined) return 'text-fg-tertiary';
  if (entry.status >= 400) return 'text-error';
  if (entry.status >= 300) return 'text-warning';
  return 'text-fg-secondary';
}
