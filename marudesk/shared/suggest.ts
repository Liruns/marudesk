import type { BookmarkEntry } from './bookmarks';
import { frecency, stripUrlPrefix, type HistoryEntry } from './history';

/**
 * Address-bar suggestion ranking. Pure and Electron-free so the policy is
 * unit-testable in isolation: main (`browser:suggest`) feeds it the history and
 * bookmark stores it owns; the renderer reuses {@link matchRanges} to highlight
 * the matched tokens in the dropdown rows.
 *
 * Order: matching bookmarks first, then history by frecency (prefix matches
 * before substring matches, mirroring the inline-complete policy in
 * electron/history.ts), then one trailing "search the web" row — except for
 * explicit-URL input, which never gets a search row. When the input resolves to
 * a real destination (`navUrl`, decided by resolveAddressBarInput in main), a
 * "Go to <host>" row leads — the direct-navigate affordance ported from pane's
 * omnibox (reference/pane/src/renderer/features/suggestions.js).
 */

export type SuggestionKind = 'history' | 'bookmark' | 'search' | 'go';

export type Suggestion = {
  kind: SuggestionKind;
  /** The URL the suggestion navigates to (the search URL for kind 'search'). */
  url: string;
  /** Page title for history/bookmark rows; the raw typed query for 'search'. */
  title: string;
};

/** Dropdown cap, including the trailing search row. */
export const SUGGEST_LIMIT = 8;

/** Whitespace-split lowercase query tokens (empty for a blank query). */
function queryTokens(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Every token appears in the scheme-stripped URL or the title. */
function matchesTokens(toks: string[], url: string, title: string): boolean {
  const u = stripUrlPrefix(url).toLowerCase();
  const t = title.toLowerCase();
  return toks.every((tok) => u.includes(tok) || t.includes(tok));
}

/** The typed text prefix-matches the URL (what inline-complete would fill). */
function isPrefixMatch(q: string, url: string): boolean {
  return (
    stripUrlPrefix(url).toLowerCase().startsWith(q) ||
    url.toLowerCase().startsWith(q)
  );
}

export function buildSuggestions(opts: {
  query: string;
  history: readonly HistoryEntry[];
  bookmarks: readonly BookmarkEntry[];
  /** Query-prefix of the configured search engine (electron/browser/url.ts). */
  searchBase: string;
  /** The resolved navigation target when the input is a real destination (host /
   *  IP / localhost / PSL domain), or omitted when it resolves to a search.
   *  Surfaces a leading "Go to <host>" row. Computed in main via
   *  resolveAddressBarInput so this ranker stays Electron-free. */
  navUrl?: string;
  limit?: number;
}): Suggestion[] {
  const { history, bookmarks, searchBase } = opts;
  const limit = opts.limit ?? SUGGEST_LIMIT;
  const typed = opts.query.trim();
  const q = typed.toLowerCase();
  const toks = queryTokens(typed);
  if (toks.length === 0 || limit <= 0) return [];

  // Explicit-URL input never gets a search row (Enter loads it directly).
  const searchRow: Suggestion | null =
    /^https?:\/\//i.test(typed) || typed === 'about:blank'
      ? null
      : {
          kind: 'search',
          url: searchBase + encodeURIComponent(typed),
          title: typed,
        };

  // Bookmarks outrank history; among them, prefix matches first, newest first.
  const bookmarkRows = bookmarks
    .filter((b) => matchesTokens(toks, b.url, b.title))
    .sort(
      (a, b) =>
        Number(isPrefixMatch(q, b.url)) - Number(isPrefixMatch(q, a.url)) ||
        b.createdAt - a.createdAt,
    )
    .map<Suggestion>((b) => ({ kind: 'bookmark', url: b.url, title: b.title }));

  // History: prefix matches first, each bucket by frecency. Skip URLs already
  // surfaced as bookmarks so a row never appears twice.
  const seen = new Set(bookmarkRows.map((s) => s.url));
  const prefix: HistoryEntry[] = [];
  const substring: HistoryEntry[] = [];
  for (const e of history) {
    if (seen.has(e.url) || !matchesTokens(toks, e.url, e.title)) continue;
    (isPrefixMatch(q, e.url) ? prefix : substring).push(e);
  }
  prefix.sort((a, b) => frecency(b) - frecency(a));
  substring.sort((a, b) => frecency(b) - frecency(a));
  const historyRows = [...prefix, ...substring].map<Suggestion>((e) => ({
    kind: 'history',
    url: e.url,
    title: e.title,
  }));

  // "Go to <host>": when the input resolves to a real destination, lead with a
  // direct-navigate row — unless that exact URL is already a bookmark/history
  // row (those carry a title and navigate there anyway).
  const known = new Set([...bookmarkRows, ...historyRows].map((s) => s.url));
  const navRow: Suggestion | null =
    opts.navUrl && opts.navUrl !== 'about:blank' && !known.has(opts.navUrl)
      ? { kind: 'go', url: opts.navUrl, title: '' }
      : null;

  const reserved = (searchRow ? 1 : 0) + (navRow ? 1 : 0);
  const cap = Math.max(limit - reserved, 0);
  const rows: Suggestion[] = [];
  if (navRow) rows.push(navRow);
  rows.push(...[...bookmarkRows, ...historyRows].slice(0, cap));
  if (searchRow) rows.push(searchRow);
  return rows.slice(0, limit);
}

/** A half-open [start, end) span of `text` that matched a query token. */
export type MatchRange = { start: number; end: number };

/**
 * Token-based highlight ranges: the first case-insensitive occurrence of each
 * whitespace-split query token in `text`, merged when they overlap and sorted
 * by position. The dropdown renders these spans in the highlight color.
 */
export function matchRanges(text: string, query: string): MatchRange[] {
  const lower = text.toLowerCase();
  const ranges: MatchRange[] = [];
  for (const tok of queryTokens(query)) {
    const at = lower.indexOf(tok);
    if (at >= 0) ranges.push({ start: at, end: at + tok.length });
  }
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: MatchRange[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}
