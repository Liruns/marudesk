import { describe, expect, it } from 'vitest';
import {
  buildBottomUp,
  curateMetrics,
  formatBytes,
  formatMs,
  parseCdpProfile,
  processProfile,
} from './performance-utils';
import type { CdpProfile } from './types';

const callFrame = (functionName: string, url = 'https://a.com/app.js', lineNumber = 0) => ({
  functionName,
  url,
  lineNumber,
});

describe('parseCdpProfile', () => {
  it('rejects non-objects and missing fields', () => {
    expect(parseCdpProfile(null)).toBeNull();
    expect(parseCdpProfile('profile')).toBeNull();
    expect(parseCdpProfile({})).toBeNull();
    expect(parseCdpProfile({ nodes: [], startTime: 0, endTime: 1 })).toBeNull();
    expect(
      parseCdpProfile({ nodes: [{ id: 1 }], startTime: 0 }),
    ).toBeNull();
  });

  it('accepts a minimal profile and normalizes call frames', () => {
    const parsed = parseCdpProfile({
      nodes: [{ id: 1, callFrame: { functionName: 42 } }],
      startTime: 0,
      endTime: 100,
      samples: [1],
      timeDeltas: [100],
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.nodes[0].callFrame).toEqual({
      functionName: '',
      url: '',
      lineNumber: -1,
    });
    expect(parsed?.samples).toEqual([1]);
  });

  it('drops malformed samples/timeDeltas arrays instead of the profile', () => {
    const parsed = parseCdpProfile({
      nodes: [{ id: 1, callFrame: callFrame('f') }],
      startTime: 0,
      endTime: 100,
      samples: [1, 'x'],
      timeDeltas: [1, 2],
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.samples).toBeUndefined();
  });
});

describe('processProfile', () => {
  // (root) → foo → baz, (root) → bar. Samples: foo 100µs, baz 500µs, bar 400µs.
  const profile: CdpProfile = {
    nodes: [
      { id: 1, callFrame: callFrame('(root)', ''), children: [2, 3] },
      { id: 2, callFrame: callFrame('foo', 'https://a.com/app.js', 10), children: [4] },
      { id: 3, callFrame: callFrame('bar', 'https://a.com/app.js', 20) },
      { id: 4, callFrame: callFrame('baz', 'https://a.com/util.js', 5) },
    ],
    startTime: 0,
    endTime: 1000,
    samples: [2, 4, 4, 3],
    timeDeltas: [100, 200, 300, 400],
  };

  it('computes self/total times in ms and sorts children by total time', () => {
    const p = processProfile(profile);
    expect(p.durationMs).toBe(1);
    expect(p.root.functionName).toBe('(root)');
    expect(p.root.totalTime).toBeCloseTo(1.0, 5);
    const [first, second] = p.root.children;
    expect(first.functionName).toBe('foo'); // total 0.6 > bar's 0.4
    expect(first.selfTime).toBeCloseTo(0.1, 5);
    expect(first.totalTime).toBeCloseTo(0.6, 5);
    expect(first.children[0].functionName).toBe('baz');
    expect(first.children[0].selfTime).toBeCloseTo(0.5, 5);
    expect(second.functionName).toBe('bar');
    expect(second.totalTime).toBeCloseTo(0.4, 5);
  });

  it('builds the bottom-up table sorted by self time descending', () => {
    const p = processProfile(profile);
    expect(p.bottomUp.map((r) => r.functionName)).toEqual(['baz', 'bar', 'foo']);
    expect(p.bottomUp[0].selfTime).toBeCloseTo(0.5, 5);
    expect(p.bottomUp[0].totalTime).toBeCloseTo(0.5, 5);
    expect(p.bottomUp[2].selfTime).toBeCloseTo(0.1, 5);
    expect(p.bottomUp[2].totalTime).toBeCloseTo(0.6, 5);
  });

  it('falls back to hitCount apportioning when samples are absent', () => {
    const p = processProfile({
      nodes: [
        { id: 1, callFrame: callFrame('(root)', ''), children: [2] },
        { id: 2, callFrame: callFrame('foo'), hitCount: 1 },
      ],
      startTime: 0,
      endTime: 1000,
    });
    expect(p.root.children[0].selfTime).toBeCloseTo(1, 5); // the whole 1000µs window
  });

  it('labels anonymous frames', () => {
    const p = processProfile({
      nodes: [{ id: 1, callFrame: callFrame('') }],
      startTime: 0,
      endTime: 10,
    });
    expect(p.root.functionName).toBe('(anonymous)');
  });
});

describe('buildBottomUp', () => {
  it('counts a recursive function\'s total time only at its topmost occurrence', () => {
    // (root) → fib → fib. Both fib nodes share one call frame identity.
    const p = processProfile({
      nodes: [
        { id: 1, callFrame: callFrame('(root)', ''), children: [2] },
        { id: 2, callFrame: callFrame('fib', 'https://a.com/app.js', 1), children: [3] },
        { id: 3, callFrame: callFrame('fib', 'https://a.com/app.js', 1) },
      ],
      startTime: 0,
      endTime: 200,
      samples: [2, 3],
      timeDeltas: [100, 100],
    });
    const rows = buildBottomUp(p.root);
    expect(rows).toHaveLength(1);
    expect(rows[0].functionName).toBe('fib');
    expect(rows[0].selfTime).toBeCloseTo(0.2, 5); // both occurrences
    expect(rows[0].totalTime).toBeCloseTo(0.2, 5); // outer occurrence only
  });
});

describe('formatters', () => {
  it('formatMs switches to seconds at 1000 ms', () => {
    expect(formatMs(12.34)).toBe('12.3 ms');
    expect(formatMs(1234)).toBe('1.23 s');
    expect(formatMs(Number.NaN)).toBe('—');
  });

  it('formatBytes scales B/KB/MB', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('curateMetrics', () => {
  it('picks the curated subset in display order and formats by kind', () => {
    const rows = curateMetrics([
      { name: 'Timestamp', value: 123 }, // not curated — dropped
      { name: 'Nodes', value: 1500 },
      { name: 'JSHeapUsedSize', value: 4 * 1024 * 1024 },
      { name: 'ScriptDuration', value: 0.25 }, // seconds → ms
    ]);
    expect(rows.map((r) => r.label)).toEqual(['JS heap used', 'DOM nodes', 'Script time']);
    expect(rows[0].value).toBe('4.0 MB');
    expect(rows[1].value).toBe('1500');
    expect(rows[2].value).toBe('250.0 ms');
  });

  it('returns nothing for an empty metrics list', () => {
    expect(curateMetrics([])).toEqual([]);
  });
});
