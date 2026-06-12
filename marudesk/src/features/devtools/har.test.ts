import { describe, expect, it } from 'vitest';
import {
  buildFetchSnippet,
  buildHar,
  buildHarEntry,
  harTimings,
  parseQueryString,
  totalTime,
} from './har';
import type { NetworkEntry } from './types';

const baseEntry: NetworkEntry = {
  requestId: 'r1',
  url: 'https://api.example.com/items?page=2&q=a%20b',
  method: 'GET',
  status: 200,
  statusText: 'OK',
  mimeType: 'application/json',
  startTime: 100,
  endTime: 100.25,
  wallTime: 1_700_000_000_000,
  encodedDataLength: 512,
  requestHeaders: { ':method': 'GET', Accept: 'application/json' },
  responseHeaders: { 'Content-Type': 'application/json' },
};

describe('parseQueryString', () => {
  it('decodes the query parameters', () => {
    expect(parseQueryString(baseEntry.url)).toEqual([
      { name: 'page', value: '2' },
      { name: 'q', value: 'a b' },
    ]);
  });

  it('returns [] for an unparseable url', () => {
    expect(parseQueryString('not a url')).toEqual([]);
  });
});

describe('harTimings', () => {
  it('maps CDP resource timing to HAR phases', () => {
    const timings = harTimings({
      ...baseEntry,
      timing: {
        requestTime: 100,
        dnsStart: 0,
        dnsEnd: 10,
        connectStart: 10,
        connectEnd: 40,
        sslStart: 20,
        sslEnd: 40,
        sendStart: 40,
        sendEnd: 45,
        receiveHeadersEnd: 145,
      },
    });
    expect(timings.dns).toBe(10);
    expect(timings.connect).toBe(30);
    expect(timings.ssl).toBe(20);
    expect(timings.send).toBe(5);
    expect(timings.wait).toBe(100);
    // endTime 100.25s → 250ms total; receive = 250 - 145.
    expect(timings.receive).toBeCloseTo(105);
    expect(timings.blocked).toBe(-1);
  });

  it('marks skipped phases -1 and zeroes required ones without timing data', () => {
    const timings = harTimings({ ...baseEntry, timing: undefined });
    expect(timings.dns).toBe(-1);
    expect(timings.connect).toBe(-1);
    expect(timings.ssl).toBe(-1);
    expect(timings.send).toBe(0);
    expect(timings.wait).toBe(0);
    expect(timings.receive).toBeCloseTo(250);
  });
});

describe('totalTime', () => {
  it('sums only the non-negative phases', () => {
    expect(
      totalTime({ blocked: -1, dns: 10, connect: -1, ssl: -1, send: 5, wait: 100, receive: 35 }),
    ).toBe(150);
  });
});

describe('buildHarEntry', () => {
  it('builds a spec-shaped entry from the captured fields', () => {
    const entry = buildHarEntry(baseEntry);
    expect(entry.startedDateTime).toBe(new Date(1_700_000_000_000).toISOString());
    expect(entry.request.method).toBe('GET');
    // Pseudo-headers are dropped.
    expect(entry.request.headers).toEqual([{ name: 'Accept', value: 'application/json' }]);
    expect(entry.request.queryString).toHaveLength(2);
    expect(entry.response.status).toBe(200);
    expect(entry.response.content).toEqual({ size: 512, mimeType: 'application/json' });
    expect(entry.response.headersSize).toBe(-1);
    expect(entry.cache).toEqual({});
    expect(entry.time).toBeCloseTo(250);
  });

  it('includes an already-fetched body with its encoding', () => {
    const entry = buildHarEntry(baseEntry, { body: 'AAAA', base64Encoded: true });
    expect(entry.response.content.text).toBe('AAAA');
    expect(entry.response.content.encoding).toBe('base64');
    expect(entry.response.content.size).toBe(4);
  });

  it('carries post data and zero status for failed requests', () => {
    const entry = buildHarEntry({
      ...baseEntry,
      method: 'POST',
      status: undefined,
      statusText: undefined,
      failed: true,
      errorText: 'net::ERR_FAILED',
      requestPostData: '{"a":1}',
      requestHeaders: { 'Content-Type': 'application/json' },
    });
    expect(entry.request.postData).toEqual({
      mimeType: 'application/json',
      text: '{"a":1}',
    });
    expect(entry.request.bodySize).toBe(7);
    expect(entry.response.status).toBe(0);
    expect(entry.response.statusText).toBe('net::ERR_FAILED');
  });
});

describe('buildHar', () => {
  it('wraps entries in a HAR 1.2 log and maps bodies by requestId', () => {
    const har = buildHar(
      [baseEntry, { ...baseEntry, requestId: 'r2' }],
      new Map([['r2', { body: 'hello', base64Encoded: false }]]),
    );
    expect(har.log.version).toBe('1.2');
    expect(har.log.creator.name).toBe('marudesk');
    expect(har.log.entries).toHaveLength(2);
    expect(har.log.entries[0].response.content.text).toBeUndefined();
    expect(har.log.entries[1].response.content.text).toBe('hello');
    expect(har.log.entries[1].response.content.encoding).toBeUndefined();
  });
});

describe('buildFetchSnippet', () => {
  it('emits a fetch call with method, headers and body', () => {
    const snippet = buildFetchSnippet({
      ...baseEntry,
      method: 'POST',
      requestPostData: '{"a":1}',
    });
    expect(snippet).toContain(`fetch("${baseEntry.url}"`);
    expect(snippet).toContain('method: "POST"');
    expect(snippet).toContain('"Accept": "application/json"');
    expect(snippet).not.toContain(':method');
    expect(snippet).toContain('body: "{\\"a\\":1}"');
  });

  it('omits headers/body blocks when absent', () => {
    const snippet = buildFetchSnippet({
      requestId: 'r3',
      url: 'https://example.com/',
      method: 'GET',
      startTime: 0,
    });
    expect(snippet).toBe('fetch("https://example.com/", {\n  method: "GET"\n});');
  });
});
