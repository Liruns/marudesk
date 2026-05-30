import { test, expect } from '@playwright/test';
import { extractNetwork } from '../shared/network-evidence';

/**
 * Pure unit coverage for the P0.5 network parser. Defensive: page-driven CDP
 * params must never crash the relay, and only the two response/failure events
 * become records.
 */

test('extractNetwork: parses Network.responseReceived', () => {
  const rec = extractNetwork('Network.responseReceived', {
    requestId: 'r1',
    type: 'XHR',
    response: {
      url: 'https://api.example.com/data',
      status: 500,
      statusText: 'Internal Server Error',
      mimeType: 'application/json',
      headers: { 'content-type': 'application/json' },
    },
  });
  expect(rec).not.toBeNull();
  expect(rec!.requestId).toBe('r1');
  expect(rec!.status).toBe(500);
  expect(rec!.resourceType).toBe('XHR');
  expect(rec!.responseHeaders?.['content-type']).toBe('application/json');
});

test('extractNetwork: parses Network.loadingFailed (blocked/CORS)', () => {
  const rec = extractNetwork('Network.loadingFailed', {
    requestId: 'r2',
    type: 'Fetch',
    blockedReason: 'cors',
  });
  expect(rec!.failed).toBe(true);
  expect(rec!.errorText).toContain('cors');
});

test('extractNetwork: ignores unrelated methods and bad params', () => {
  expect(extractNetwork('Network.dataReceived', { requestId: 'r3' })).toBeNull();
  expect(extractNetwork('Runtime.consoleAPICalled', {})).toBeNull();
  // missing requestId → not a usable record
  expect(extractNetwork('Network.responseReceived', { response: {} })).toBeNull();
  // hostile params must not throw
  expect(() => extractNetwork('Network.responseReceived', null)).not.toThrow();
});
