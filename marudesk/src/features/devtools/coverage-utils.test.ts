import { describe, expect, it } from 'vitest';
import {
  cssSheetUsage,
  flattenCoverageRanges,
  jsScriptUsage,
  mergedLength,
  sortByUnusedDesc,
  truncateMiddle,
  usagePercent,
  type CoverageRow,
} from './coverage-utils';

describe('mergedLength', () => {
  it('sums disjoint ranges', () => {
    expect(
      mergedLength([
        { startOffset: 0, endOffset: 10 },
        { startOffset: 20, endOffset: 25 },
      ]),
    ).toBe(15);
  });

  it('merges overlapping and contained ranges', () => {
    expect(
      mergedLength([
        { startOffset: 0, endOffset: 10 },
        { startOffset: 5, endOffset: 15 },
        { startOffset: 6, endOffset: 8 },
      ]),
    ).toBe(15);
  });

  it('ignores empty/inverted ranges', () => {
    expect(mergedLength([{ startOffset: 5, endOffset: 5 }])).toBe(0);
    expect(mergedLength([])).toBe(0);
  });
});

describe('flattenCoverageRanges', () => {
  it('lets the innermost range win', () => {
    const segments = flattenCoverageRanges([
      { startOffset: 0, endOffset: 100, count: 1 },
      { startOffset: 20, endOffset: 40, count: 0 },
    ]);
    expect(segments).toEqual([
      { startOffset: 0, endOffset: 20, count: 1 },
      { startOffset: 20, endOffset: 40, count: 0 },
      { startOffset: 40, endOffset: 100, count: 1 },
    ]);
  });

  it('handles nested executed ranges inside dead code', () => {
    const segments = flattenCoverageRanges([
      { startOffset: 0, endOffset: 100, count: 0 },
      { startOffset: 10, endOffset: 50, count: 3 },
      { startOffset: 20, endOffset: 30, count: 0 },
    ]);
    expect(segments).toEqual([
      { startOffset: 0, endOffset: 10, count: 0 },
      { startOffset: 10, endOffset: 20, count: 3 },
      { startOffset: 20, endOffset: 30, count: 0 },
      { startOffset: 30, endOffset: 50, count: 3 },
      { startOffset: 50, endOffset: 100, count: 0 },
    ]);
  });
});

describe('jsScriptUsage', () => {
  it('computes used/total bytes across functions', () => {
    const { usedBytes, totalBytes } = jsScriptUsage([
      // Root range spans the whole script (detailed precise coverage).
      { functionName: '', isBlockCoverage: false, ranges: [{ startOffset: 0, endOffset: 200, count: 1 }] },
      { functionName: 'dead', isBlockCoverage: true, ranges: [{ startOffset: 50, endOffset: 90, count: 0 }] },
      { functionName: 'hot', isBlockCoverage: true, ranges: [{ startOffset: 100, endOffset: 120, count: 7 }] },
    ]);
    expect(totalBytes).toBe(200);
    expect(usedBytes).toBe(160); // 200 - the 40-byte dead function
  });

  it('returns zeros for no coverage', () => {
    expect(jsScriptUsage([])).toEqual({ usedBytes: 0, totalBytes: 0 });
  });
});

describe('cssSheetUsage', () => {
  it('merges used rule ranges against the sheet length', () => {
    const { usedBytes, totalBytes } = cssSheetUsage(
      [
        { styleSheetId: 's1', startOffset: 0, endOffset: 30, used: true },
        { styleSheetId: 's1', startOffset: 10, endOffset: 40, used: true },
        { styleSheetId: 's1', startOffset: 50, endOffset: 90, used: false },
      ],
      120,
    );
    expect(usedBytes).toBe(40);
    expect(totalBytes).toBe(120);
  });

  it('falls back to the ranges extent when the length is unknown', () => {
    const { totalBytes } = cssSheetUsage(
      [{ styleSheetId: 's1', startOffset: 0, endOffset: 80, used: false }],
      0,
    );
    expect(totalBytes).toBe(80);
  });
});

describe('sortByUnusedDesc / usagePercent', () => {
  const rows: CoverageRow[] = [
    { id: 'a', url: 'https://a.com/a.js', kind: 'js', usedBytes: 90, totalBytes: 100 },
    { id: 'b', url: 'https://a.com/b.css', kind: 'css', usedBytes: 10, totalBytes: 100 },
    { id: 'c', url: 'https://a.com/c.js', kind: 'js', usedBytes: 50, totalBytes: 100 },
  ];

  it('sorts by unused bytes descending', () => {
    expect(sortByUnusedDesc(rows).map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('computes a clamped percentage', () => {
    expect(usagePercent(rows[0])).toBe(90);
    expect(usagePercent({ ...rows[0], totalBytes: 0 })).toBe(0);
    expect(usagePercent({ ...rows[0], usedBytes: 150 })).toBe(100);
  });
});

describe('truncateMiddle', () => {
  it('keeps short strings intact', () => {
    expect(truncateMiddle('app.js', 20)).toBe('app.js');
  });

  it('ellipsizes the middle at the requested width', () => {
    const out = truncateMiddle('https://example.com/static/js/vendor.bundle.min.js', 25);
    expect(out).toHaveLength(25);
    expect(out.startsWith('https://')).toBe(true);
    expect(out.endsWith('.min.js')).toBe(true);
    expect(out).toContain('…');
  });
});
