import type { NetworkEntry } from './types';

/**
 * Pure request-export helpers for the Network panel: a spec-compliant HAR 1.2
 * builder (http://www.softwareishard.com/blog/har-12-spec/) and the
 * "Copy as fetch" snippet. No React, no store, no CDP — every function maps the
 * captured {@link NetworkEntry} state to plain data, so this stays unit-testable
 * (see har.test.ts).
 *
 * Fidelity notes: we export what the capture pipeline actually holds. Fields the
 * entries don't carry are zeroed or `-1`-ed per the spec's "unknown" convention
 * (`headersSize`/`bodySize: -1`, optional timing phases `-1`), and response
 * bodies are included only when the caller already fetched them — the exporter
 * never pulls bodies itself.
 */

export type HarNameValue = { name: string; value: string };

export type HarTimings = {
  blocked: number;
  dns: number;
  connect: number;
  ssl: number;
  send: number;
  wait: number;
  receive: number;
};

export type HarContent = {
  size: number;
  mimeType: string;
  text?: string;
  encoding?: 'base64';
};

export type HarEntry = {
  startedDateTime: string;
  /** Total elapsed time in ms (sum of the non-negative timing phases). */
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    headers: HarNameValue[];
    queryString: HarNameValue[];
    cookies: HarNameValue[];
    headersSize: number;
    bodySize: number;
    postData?: { mimeType: string; text: string };
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    headers: HarNameValue[];
    cookies: HarNameValue[];
    content: HarContent;
    redirectURL: string;
    headersSize: number;
    bodySize: number;
  };
  cache: Record<string, never>;
  timings: HarTimings;
};

export type Har = {
  log: {
    version: '1.2';
    creator: { name: string; version: string };
    entries: HarEntry[];
  };
};

/** A response body the caller already pulled via `Network.getResponseBody`. */
export type HarResponseBody = { body: string; base64Encoded: boolean };

function toNameValues(headers: Record<string, string> | undefined): HarNameValue[] {
  if (!headers) return [];
  // HTTP/2 pseudo-headers (`:method`, `:path`, …) aren't real header fields.
  return Object.entries(headers)
    .filter(([name]) => !name.startsWith(':'))
    .map(([name, value]) => ({ name, value }));
}

/** The URL's query parameters as HAR `queryString` items ([] when unparseable). */
export function parseQueryString(url: string): HarNameValue[] {
  try {
    return [...new URL(url).searchParams.entries()].map(([name, value]) => ({
      name,
      value,
    }));
  } catch {
    return [];
  }
}

function phase(start: number, end: number): number {
  if (start < 0 || end < 0 || end < start) return -1;
  return end - start;
}

/**
 * Map a CDP `Network.ResourceTiming` (ms offsets relative to `requestTime`) to the
 * HAR phases. `receive` runs from headers-received to the entry's end when the
 * load finished; without timing data the required phases are zeroed and
 * `receive` carries the whole wall duration so `time` still adds up.
 */
export function harTimings(entry: NetworkEntry): HarTimings {
  const wallMs =
    entry.endTime !== undefined ? Math.max(0, (entry.endTime - entry.startTime) * 1000) : 0;
  const t = entry.timing;
  if (!t) {
    return { blocked: -1, dns: -1, connect: -1, ssl: -1, send: 0, wait: 0, receive: wallMs };
  }
  const endMs =
    entry.endTime !== undefined
      ? Math.max((entry.endTime - t.requestTime) * 1000, t.receiveHeadersEnd)
      : t.receiveHeadersEnd;
  return {
    blocked: -1,
    dns: phase(t.dnsStart, t.dnsEnd),
    connect: phase(t.connectStart, t.connectEnd),
    ssl: phase(t.sslStart, t.sslEnd),
    send: Math.max(0, phase(t.sendStart, t.sendEnd)),
    wait: Math.max(0, phase(t.sendEnd, t.receiveHeadersEnd)),
    receive: Math.max(0, endMs - t.receiveHeadersEnd),
  };
}

/** `time` per spec: the sum of all timing phases, excluding `-1` ones. */
export function totalTime(timings: HarTimings): number {
  let sum = 0;
  for (const v of Object.values(timings)) if (v >= 0) sum += v;
  return sum;
}

export function buildHarEntry(entry: NetworkEntry, body?: HarResponseBody): HarEntry {
  const timings = harTimings(entry);
  const content: HarContent = {
    // Without a fetched body the decoded size is unknown — fall back to the
    // transfer size, else 0 (the spec's content.size is required).
    size: body ? body.body.length : (entry.encodedDataLength ?? 0),
    mimeType: entry.mimeType ?? 'x-unknown',
  };
  if (body) {
    content.text = body.body;
    if (body.base64Encoded) content.encoding = 'base64';
  }
  return {
    startedDateTime: new Date(entry.wallTime ?? 0).toISOString(),
    time: totalTime(timings),
    request: {
      method: entry.method || 'GET',
      url: entry.url,
      httpVersion: '',
      headers: toNameValues(entry.requestHeaders),
      queryString: parseQueryString(entry.url),
      cookies: [],
      headersSize: -1,
      bodySize: entry.requestPostData !== undefined ? entry.requestPostData.length : -1,
      ...(entry.requestPostData !== undefined
        ? {
            postData: {
              mimeType: headerValueOf(entry.requestHeaders, 'content-type') ?? 'x-unknown',
              text: entry.requestPostData,
            },
          }
        : {}),
    },
    response: {
      // 0 = no response (transport failure / still pending), per HAR convention.
      status: entry.status ?? 0,
      statusText: entry.statusText ?? (entry.failed ? (entry.errorText ?? '') : ''),
      httpVersion: '',
      headers: toNameValues(entry.responseHeaders),
      cookies: [],
      content,
      redirectURL: headerValueOf(entry.responseHeaders, 'location') ?? '',
      headersSize: -1,
      bodySize: entry.encodedDataLength ?? -1,
    },
    cache: {},
    timings,
  };
}

/**
 * Build the full HAR document from the captured network log. `bodies` maps
 * requestId → an already-fetched response body; entries without one export
 * headers/timings only (the exporter never mass-fetches bodies).
 */
export function buildHar(
  entries: readonly NetworkEntry[],
  bodies?: ReadonlyMap<string, HarResponseBody>,
  creator: { name: string; version: string } = { name: 'marudesk', version: '1.0' },
): Har {
  return {
    log: {
      version: '1.2',
      creator,
      entries: entries.map((e) => buildHarEntry(e, bodies?.get(e.requestId))),
    },
  };
}

function headerValueOf(
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

/**
 * Build a `fetch(url, init)` snippet for a request (the sibling of
 * network-utils' Copy-as-cURL). Headers skip HTTP/2 pseudo-headers; the body is
 * included when the capture holds the post data. Display/copy only.
 */
export function buildFetchSnippet(entry: NetworkEntry): string {
  const init: string[] = [`method: ${JSON.stringify(entry.method || 'GET')}`];
  const headers = Object.entries(entry.requestHeaders ?? {}).filter(
    ([name]) => !name.startsWith(':'),
  );
  if (headers.length > 0) {
    const lines = headers
      .map(([name, value]) => `    ${JSON.stringify(name)}: ${JSON.stringify(value)}`)
      .join(',\n');
    init.push(`headers: {\n${lines}\n  }`);
  }
  if (entry.requestPostData !== undefined) {
    init.push(`body: ${JSON.stringify(entry.requestPostData)}`);
  }
  return `fetch(${JSON.stringify(entry.url)}, {\n  ${init.join(',\n  ')}\n});`;
}
