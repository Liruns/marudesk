/**
 * Line-addressable paging for the agent's file/document tools (read_file,
 * read_workspace_file, the stale-edit echo). Centralised so the windowing,
 * per-line clip, and continuation footer stay identical across every tool that
 * shows file text.
 */

import { lineAnchor } from './line-anchor';

/** Default lines returned per read; large files page with `offset`. */
export const MAX_READ_LINES = 1_500;
/** Per-line clip so one pathological (e.g. minified) line can't dominate. */
const MAX_READ_LINE_LEN = 2_000;
/** Byte budget for a single windowed view (matches the tool-result clip). */
const MAX_WINDOW_BYTES = 12_000;

/** Coerce a tool input into a positive integer, falling back when absent/invalid. */
export function toPosInt(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : fallback;
}

function clipLine(line: string): string {
  return line.length <= MAX_READ_LINE_LEN
    ? line
    : `${line.slice(0, MAX_READ_LINE_LEN)}… [line truncated, ${line.length} chars]`;
}

export type PagedView = {
  /** Line-numbered window plus any continuation footer. */
  text: string;
  /** True when only part of the file is shown (a range, not the whole thing). */
  ranged: boolean;
  /** 1-based first/last line numbers actually shown (for the summary). */
  firstLine: number;
  lastLine: number;
};

/**
 * Render a line window of `content` starting at 1-based `offset` for up to
 * `limit` lines, with right-aligned `N\t` prefixes (display only — NOT part of
 * the file), bounded by a byte budget and a per-line clip. Set `truncated` when
 * `content` is itself a prefix of a larger file so the footer says so. Always
 * shows at least the first requested line, and appends a footer telling the
 * model how to read the next chunk.
 *
 * With `anchors`, each line's prefix becomes `N <hash>\t` (the v6 §W1 B-layer):
 * a short, stable per-line content hash the model can reference in an edit's
 * `anchor` instead of copying the line verbatim. The `\t` stays the prefix↔text
 * delimiter, so a model that already strips the prefix is unaffected.
 */
export function pageLines(
  content: string,
  opts: { offset?: unknown; limit?: unknown; truncated?: boolean; anchors?: boolean } = {},
): PagedView {
  if (content.length === 0 && !opts.truncated) {
    return { text: '(empty file)', ranged: false, firstLine: 1, lastLine: 0 };
  }
  const lines = content.split('\n');
  const total = lines.length;
  const start = Math.min(toPosInt(opts.offset, 1), total);
  const limit = Math.min(toPosInt(opts.limit, MAX_READ_LINES), MAX_READ_LINES);
  const end = Math.min(start + limit - 1, total);
  const width = String(end).length;
  const parts: string[] = [];
  let used = 0;
  let lastShown = start - 1;
  for (let i = start; i <= end; i++) {
    const line = lines[i - 1];
    const prefix = opts.anchors
      ? `${String(i).padStart(width, ' ')} ${lineAnchor(line)}\t`
      : `${String(i).padStart(width, ' ')}\t`;
    const rendered = `${prefix}${clipLine(line)}`;
    if (i > start && used + rendered.length + 1 > MAX_WINDOW_BYTES) break;
    parts.push(rendered);
    used += rendered.length + 1;
    lastShown = i;
  }
  let footer = '';
  if (lastShown < total) {
    footer = `\n…(showing lines ${start}-${lastShown} of ${opts.truncated ? `${total}+` : total} — read with offset=${lastShown + 1} for more)`;
  } else if (opts.truncated) {
    footer = `\n…(file exceeds the agent read limit; lines past ${total} are not shown)`;
  }
  return {
    text: parts.join('\n') + footer,
    ranged: start > 1 || lastShown < total,
    firstLine: start,
    lastLine: lastShown,
  };
}
