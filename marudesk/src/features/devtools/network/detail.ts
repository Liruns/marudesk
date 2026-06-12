import type { NetworkEntry } from '../types';

/**
 * Pure derivation helpers for the Network detail pane's tabs (no React, no
 * store): query-string / form-body parsing for the Payload tab, and the classic
 * per-phase timing breakdown (blocked → DNS → connect → TLS → send → wait →
 * receive) for the Timing tab. Follows the console/completion.ts precedent of
 * keeping store-free domain logic in its own module.
 */

/** Parse a request URL's query string into ordered [key, value] pairs. */
export function parseQueryParams(url: string): [string, string][] {
  try {
    return [...new URL(url).searchParams.entries()];
  } catch {
    return [];
  }
}

/**
 * Parse a form-encoded request body into [key, value] pairs, or null when the
 * content type isn't `application/x-www-form-urlencoded` (the caller falls back
 * to JSON pretty-print / raw).
 */
export function parseFormBody(
  body: string,
  contentType: string | undefined,
): [string, string][] | null {
  if (!contentType || !/application\/x-www-form-urlencoded/i.test(contentType)) return null;
  try {
    return [...new URLSearchParams(body).entries()];
  } catch {
    return null;
  }
}

export type TimingPhaseKey =
  | 'blocked'
  | 'dns'
  | 'connect'
  | 'tls'
  | 'send'
  | 'wait'
  | 'receive';

/** One phase window in ms relative to `timing.requestTime`. */
export type TimingPhase = { key: TimingPhaseKey; startMs: number; endMs: number };

/**
 * Derive the classic DevTools phase bars from `Network.responseReceived`'s
 * resource timing. CDP marks a phase that didn't occur as `-1`; zero-width
 * phases are skipped. Returns null when the entry has no timing at all (cache
 * hit / early failure) — the caller renders a graceful fallback.
 */
export function timingPhases(
  entry: NetworkEntry,
): { phases: TimingPhase[]; totalMs: number } | null {
  const t = entry.timing;
  if (!t) return null;
  const phases: TimingPhase[] = [];
  // Blocked/stalled: queueing before the first observable activity.
  const starts = [t.dnsStart, t.connectStart, t.sendStart].filter((v) => v >= 0);
  const firstActivity = starts.length > 0 ? Math.min(...starts) : -1;
  if (firstActivity > 0) phases.push({ key: 'blocked', startMs: 0, endMs: firstActivity });
  const windows: [TimingPhaseKey, number, number][] = [
    ['dns', t.dnsStart, t.dnsEnd],
    ['connect', t.connectStart, t.connectEnd],
    ['tls', t.sslStart, t.sslEnd],
    ['send', t.sendStart, t.sendEnd],
    ['wait', t.sendEnd, t.receiveHeadersEnd],
  ];
  for (const [key, startMs, endMs] of windows) {
    if (startMs >= 0 && endMs >= 0 && endMs > startMs) phases.push({ key, startMs, endMs });
  }
  // Receive: headers-received → loadingFinished (when the end is known).
  const endMs =
    entry.endTime !== undefined
      ? (entry.endTime - t.requestTime) * 1000
      : t.receiveHeadersEnd;
  if (entry.endTime !== undefined && endMs > t.receiveHeadersEnd && t.receiveHeadersEnd >= 0) {
    phases.push({ key: 'receive', startMs: t.receiveHeadersEnd, endMs });
  }
  return { phases, totalMs: Math.max(endMs, t.receiveHeadersEnd, 0) };
}

/**
 * Format a frame's CDP-monotonic timestamp as wall-clock `HH:MM:SS.mmm` using
 * the connection's wallTime↔startTime anchor; falls back to seconds relative to
 * the connection start when the anchor is missing.
 */
export function frameClock(entry: NetworkEntry, timestamp: number): string {
  if (entry.wallTime !== undefined) {
    const epochMs = entry.wallTime + (timestamp - entry.startTime) * 1000;
    const d = new Date(epochMs);
    const pad = (n: number, w = 2) => String(n).padStart(w, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  }
  return `+${(timestamp - entry.startTime).toFixed(3)}s`;
}
