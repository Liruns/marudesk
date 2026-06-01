import { test, expect } from '@playwright/test';
import { extractConsoleMessage } from '../shared/runtime-evidence';

/**
 * Pure unit coverage for extractConsoleMessage (DevTools 고도화 / M2) — the all-level
 * console capture that feeds the agent's `read_console`. It runs on every CDP
 * message from the always-on Runtime stream, so it must be fast, total on
 * `unknown` page-originated params (never throw), and map console types to levels
 * correctly. Runs in the Playwright worker (Node); no Electron launch.
 */

const FRAME = { functionName: 'fn', url: 'http://localhost:5173/src/app.ts', lineNumber: 9, columnNumber: 2 };

function called(type: string, args: unknown[] = [], extra: Record<string, unknown> = {}) {
  return extractConsoleMessage('Runtime.consoleAPICalled', { type, args, ...extra });
}

test('extractConsoleMessage: only Runtime.consoleAPICalled is captured (exceptions are not)', () => {
  expect(extractConsoleMessage('Runtime.exceptionThrown', { exceptionDetails: {} })).toBeNull();
  expect(extractConsoleMessage('Network.requestWillBeSent', {})).toBeNull();
  expect(extractConsoleMessage('Log.entryAdded', { entry: {} })).toBeNull();
});

test('extractConsoleMessage: maps CDP console types to coarse levels', () => {
  const cases: [string, string][] = [
    ['error', 'error'],
    ['assert', 'error'],
    ['warning', 'warning'],
    ['info', 'info'],
    ['debug', 'debug'],
    ['verbose', 'debug'],
    ['log', 'log'],
    ['dir', 'log'],
    ['table', 'log'],
    ['trace', 'log'],
  ];
  for (const [type, level] of cases) {
    expect(called(type, [{ type: 'string', value: 'x' }])?.level).toBe(level);
  }
});

test('extractConsoleMessage: renders primitive + object args into one text', () => {
  const msg = called('log', [
    { type: 'string', value: 'count is' },
    { type: 'number', value: 42 },
    { type: 'object', description: 'Array(3)' },
  ]);
  expect(msg?.text).toBe('count is 42 Array(3)');
  expect(msg?.type).toBe('log');
});

test('extractConsoleMessage: empty args fall back to "console.<type>"', () => {
  expect(called('warning', [])?.text).toBe('console.warning');
});

test('extractConsoleMessage: bounds very long text and marks the elision', () => {
  const big = 'a'.repeat(5000);
  const msg = called('log', [{ type: 'string', value: big }]);
  expect(msg!.text.length).toBeLessThanOrEqual(2001);
  expect(msg!.text.endsWith('…')).toBe(true);
});

test('extractConsoleMessage: lifts the top stack frame with a URL as source', () => {
  const msg = called('error', [{ value: 'boom' }], { stackTrace: { callFrames: [FRAME] } });
  expect(msg?.source?.url).toBe(FRAME.url);
  expect(msg?.source?.lineNumber).toBe(9);
});

test('extractConsoleMessage: total/defensive on garbage params (never throws)', () => {
  expect(() => extractConsoleMessage('Runtime.consoleAPICalled', null)).not.toThrow();
  expect(extractConsoleMessage('Runtime.consoleAPICalled', null)?.level).toBe('log');
  expect(extractConsoleMessage('Runtime.consoleAPICalled', { type: 123, args: 'nope' })?.text).toBe('console.log');
  expect(called('log', [{ weird: true }])?.text).toBe('console.log'); // unrenderable arg → empty → fallback
});
