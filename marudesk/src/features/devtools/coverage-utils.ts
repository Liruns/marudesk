import type {
  CssRuleUsage,
  ProfilerCoverageRange,
  ProfilerFunctionCoverage,
} from './types';

/**
 * Pure byte-range → usage math for the Coverage section (Rendering panel). The
 * JS half flattens V8's nested precise-coverage ranges (innermost range wins)
 * into disjoint segments; the CSS half merges the `used` rule ranges. No CDP and
 * no store access — see coverage-utils.test.ts.
 */

export type CoverageKind = 'js' | 'css';

export type CoverageRow = {
  /** Stable row key (`js:<scriptId>` / `css:<styleSheetId>`). */
  id: string;
  url: string;
  kind: CoverageKind;
  usedBytes: number;
  totalBytes: number;
};

export type ByteRange = { startOffset: number; endOffset: number };

/** Total length covered by the ranges, with overlaps merged. */
export function mergedLength(ranges: readonly ByteRange[]): number {
  const sorted = ranges
    .filter((r) => r.endOffset > r.startOffset)
    .sort((a, b) => a.startOffset - b.startOffset);
  let total = 0;
  let end = -1;
  for (const r of sorted) {
    if (r.startOffset >= end) {
      total += r.endOffset - r.startOffset;
      end = r.endOffset;
    } else if (r.endOffset > end) {
      total += r.endOffset - end;
      end = r.endOffset;
    }
  }
  return total;
}

/**
 * Flatten V8 coverage ranges (a properly nested tree per script — parents
 * enclose children) into disjoint segments where the innermost range's count
 * wins. This is what makes `count: 0` ranges nested inside an executed root
 * read as unused bytes.
 */
export function flattenCoverageRanges(
  ranges: readonly ProfilerCoverageRange[],
): { startOffset: number; endOffset: number; count: number }[] {
  // Parents first: by start ascending, then by end descending.
  const sorted = [...ranges].sort(
    (a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset,
  );
  const stack: ProfilerCoverageRange[] = [];
  const segments: { startOffset: number; endOffset: number; count: number }[] = [];
  let pos = 0;
  const emit = (endOffset: number, count: number) => {
    if (endOffset > pos) {
      segments.push({ startOffset: pos, endOffset, count });
      pos = endOffset;
    }
  };
  for (const r of sorted) {
    // Close every range that ends before this one starts.
    while (stack.length > 0 && stack[stack.length - 1].endOffset <= r.startOffset) {
      const top = stack.pop();
      if (top) emit(top.endOffset, top.count);
    }
    // The gap up to this range belongs to the enclosing range (if any).
    const parent = stack[stack.length - 1];
    if (parent) emit(Math.max(pos, r.startOffset), parent.count);
    pos = Math.max(pos, r.startOffset);
    stack.push(r);
  }
  while (stack.length > 0) {
    const top = stack.pop();
    if (top) emit(top.endOffset, top.count);
  }
  return segments;
}

/**
 * Per-script used/total bytes from `Profiler.takePreciseCoverage` functions.
 * Total is the script extent the coverage describes (the root function range
 * spans the whole script under `detailed: true`).
 */
export function jsScriptUsage(functions: readonly ProfilerFunctionCoverage[]): {
  usedBytes: number;
  totalBytes: number;
} {
  const all: ProfilerCoverageRange[] = [];
  for (const fn of functions) all.push(...fn.ranges);
  const segments = flattenCoverageRanges(all);
  let usedBytes = 0;
  let totalBytes = 0;
  for (const s of segments) {
    const len = s.endOffset - s.startOffset;
    totalBytes = Math.max(totalBytes, s.endOffset);
    if (s.count > 0) usedBytes += len;
  }
  return { usedBytes, totalBytes };
}

/** Per-stylesheet used bytes from the sheet's `CSS.RuleUsage` entries. */
export function cssSheetUsage(
  ranges: readonly CssRuleUsage[],
  sheetLength: number,
): { usedBytes: number; totalBytes: number } {
  const usedBytes = mergedLength(ranges.filter((r) => r.used));
  // The header length is authoritative; fall back to the ranges' extent.
  const extent = ranges.reduce((max, r) => Math.max(max, r.endOffset), 0);
  return { usedBytes, totalBytes: Math.max(sheetLength, extent) };
}

export function unusedBytes(row: CoverageRow): number {
  return Math.max(0, row.totalBytes - row.usedBytes);
}

export function usagePercent(row: CoverageRow): number {
  if (row.totalBytes <= 0) return 0;
  return Math.min(100, (row.usedBytes / row.totalBytes) * 100);
}

/** Result-table order: the biggest dead weight first. */
export function sortByUnusedDesc(rows: readonly CoverageRow[]): CoverageRow[] {
  return [...rows].sort((a, b) => unusedBytes(b) - unusedBytes(a) || a.url.localeCompare(b.url));
}

/** Middle-ellipsis a URL so the origin and the file tail both stay readable. */
export function truncateMiddle(text: string, max: number): string {
  if (max < 5 || text.length <= max) return text;
  const head = Math.ceil((max - 1) / 2);
  const tail = max - 1 - head;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}
