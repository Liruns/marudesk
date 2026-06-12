import { describe, it, expect } from 'vitest';
import {
  createTerminalErrorDetector,
  stripAnsi,
  TERMINAL_EXCERPT_MAX_LINES,
} from './terminal-evidence';

describe('stripAnsi', () => {
  it('removes CSI color and OSC title sequences', () => {
    expect(stripAnsi('\x1b[31merror\x1b[0m TS2304: x')).toBe('error TS2304: x');
    expect(stripAnsi('\x1b]0;title\x07plain')).toBe('plain');
  });
});

describe('createTerminalErrorDetector', () => {
  it('detects a vite/esbuild build error with leading context', () => {
    const d = createTerminalErrorDetector();
    const events = d.push(
      [
        '$ npm run build',
        'vite v5.0.0 building for production...',
        '✘ [ERROR] Expected ";" but found "}"',
        '',
        '    src/app.ts:10:2:',
        '      10 │ }',
        'Build failed with 1 error',
        '$ ', // prompt-like line closes the run
        '',
      ].join('\n'),
    );
    expect(events).toHaveLength(1);
    expect(events[0].message).toContain('✘ [ERROR]');
    // Leading context rides along…
    expect(events[0].excerpt).toContain('vite v5.0.0 building');
    // …and the consecutive matching run (code frame + summary) coalesced in.
    expect(events[0].excerpt).toContain('src/app.ts:10:2:');
    // The closing prompt line is NOT part of the excerpt (it ends at the run).
    expect(events[0].excerpt.endsWith('Build failed with 1 error')).toBe(true);
  });

  it('detects a tsc error (ANSI-colored) and coalesces consecutive errors', () => {
    const d = createTerminalErrorDetector();
    const events = d.push(
      [
        "src/a.ts(1,5): \x1b[31merror TS2304\x1b[0m: Cannot find name 'foo'.",
        "src/b.ts(2,1): error TS2339: Property 'x' does not exist.",
        'done\n',
      ].join('\n'),
    );
    expect(events).toHaveLength(1);
    expect(events[0].message).toContain('error TS2304');
    expect(events[0].excerpt).toContain('error TS2339');
    expect(events[0].excerpt).not.toContain('\x1b'); // ANSI stripped
  });

  it('detects a runtime error with its stack trace', () => {
    const d = createTerminalErrorDetector();
    d.push('TypeError: Cannot read properties of undefined\n');
    d.push('    at main (/srv/app/index.js:3:11)\n');
    d.push('    at node:internal/main:12:5\n');
    const events = d.flush();
    expect(events).toHaveLength(1);
    expect(events[0].message).toBe('TypeError: Cannot read properties of undefined');
    expect(events[0].excerpt).toContain('at main (/srv/app/index.js:3:11)');
  });

  it('emits nothing for passing output', () => {
    const d = createTerminalErrorDetector();
    const events = d.push(
      [
        '$ npm test',
        '✓ renders the header',
        '✓ handles clicks',
        'Test Files  3 passed (3)',
        '      Tests  12 passed (12)',
        '',
      ].join('\n'),
    );
    expect(events).toHaveLength(0);
    expect(d.flush()).toHaveLength(0);
  });

  it('dedupes an identical excerpt (same hash never re-fires)', () => {
    const d = createTerminalErrorDetector();
    const errorRun = 'Error: listen EADDRINUSE: address already in use :::3000\nok line\n';
    const first = d.push(errorRun);
    expect(first).toHaveLength(1);
    const second = d.push(errorRun);
    expect(second).toHaveLength(0);
    // A different error still fires.
    const third = d.push("Error: Cannot find module 'left-pad'\nok line\n");
    expect(third).toHaveLength(1);
  });

  it('bounds the excerpt to the max line cap', () => {
    const d = createTerminalErrorDetector();
    const lines = ['FAIL src/big.test.ts'];
    for (let i = 0; i < 100; i++) lines.push(`    at frame${i} (/x.js:${i}:1)`);
    lines.push('closing line', '');
    const events = d.push(lines.join('\n'));
    expect(events).toHaveLength(1);
    const count = events[0].excerpt.split('\n').length;
    expect(count).toBeLessThanOrEqual(TERMINAL_EXCERPT_MAX_LINES);
  });

  it('flush() closes an event that is the last output (partial line included)', () => {
    const d = createTerminalErrorDetector();
    // No trailing newline — the error is a buffered partial line.
    expect(d.push('Traceback (most recent call last)')).toHaveLength(0);
    const events = d.flush();
    expect(events).toHaveLength(1);
    expect(events[0].message).toBe('Traceback (most recent call last)');
  });
});
