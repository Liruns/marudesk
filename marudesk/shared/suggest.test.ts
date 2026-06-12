import { describe, expect, it } from 'vitest';
import { buildSuggestions, matchRanges, SUGGEST_LIMIT } from './suggest';
import type { Bookmark } from './bookmarks';
import type { HistoryEntry } from './history';

const SEARCH_BASE = 'https://www.google.com/search?q=';

function h(
  url: string,
  title: string,
  visitCount = 1,
  lastVisit = 0,
): HistoryEntry {
  return { url, title, visitCount, lastVisit };
}

function b(url: string, title: string, createdAt = 0): Bookmark {
  return { id: `bm-${url}`, url, title, createdAt };
}

function build(
  query: string,
  history: HistoryEntry[] = [],
  bookmarks: Bookmark[] = [],
  limit?: number,
) {
  return buildSuggestions({ query, history, bookmarks, searchBase: SEARCH_BASE, limit });
}

describe('buildSuggestions', () => {
  it('returns nothing for a blank query', () => {
    expect(build('', [h('https://a.com', 'A')])).toEqual([]);
    expect(build('   ', [h('https://a.com', 'A')])).toEqual([]);
  });

  it('matches history by URL or title substring and ends with the search row', () => {
    const rows = build('release', [
      h('https://github.com/marudesk/releases', 'Releases'),
      h('https://unrelated.dev/', 'Docs'),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(['history', 'search']);
    expect(rows[0]?.url).toBe('https://github.com/marudesk/releases');
    expect(rows[1]).toEqual({
      kind: 'search',
      url: `${SEARCH_BASE}release`,
      title: 'release',
    });
  });

  it('ranks history by frecency: visit count first, recency breaks ties', () => {
    const rows = build('site', [
      h('https://site.com/rare', 'rare', 1, 999),
      h('https://site.com/hot', 'hot', 9, 5),
      h('https://site.com/tie-new', 'tie new', 3, 200),
      h('https://site.com/tie-old', 'tie old', 3, 100),
    ]);
    expect(rows.filter((r) => r.kind === 'history').map((r) => r.url)).toEqual([
      'https://site.com/hot',
      'https://site.com/tie-new',
      'https://site.com/tie-old',
      'https://site.com/rare',
    ]);
  });

  it('puts prefix matches ahead of substring matches regardless of frecency', () => {
    const rows = build('git', [
      h('https://example.com/git-tips', 'tips', 50, 50),
      h('https://github.com/', 'GitHub', 1, 1),
    ]);
    expect(rows[0]?.url).toBe('https://github.com/');
    expect(rows[1]?.url).toBe('https://example.com/git-tips');
  });

  it('ranks matching bookmarks above history and dedupes shared URLs', () => {
    const rows = build(
      'docs',
      [h('https://docs.dev/a', 'Docs A', 100, 100), h('https://docs.dev/b', 'Docs B')],
      [b('https://docs.dev/a', 'Docs A')],
    );
    expect(rows.map((r) => r.kind)).toEqual(['bookmark', 'history', 'search']);
    expect(rows[0]?.url).toBe('https://docs.dev/a');
    // The bookmarked URL must not also appear as a history row.
    expect(rows.filter((r) => r.url === 'https://docs.dev/a')).toHaveLength(1);
  });

  it('matches every whitespace-separated token (URL or title, any order)', () => {
    const history = [
      h('https://news.ycombinator.com/', 'Hacker News'),
      h('https://news.example.com/', 'Other'),
    ];
    const rows = build('news hacker', history);
    expect(rows.filter((r) => r.kind === 'history').map((r) => r.url)).toEqual([
      'https://news.ycombinator.com/',
    ]);
  });

  it('caps the list at the limit, search row included', () => {
    const history = Array.from({ length: 20 }, (_, i) =>
      h(`https://site${i}.com/`, `site ${i}`, 20 - i),
    );
    const rows = build('site', history);
    expect(rows).toHaveLength(SUGGEST_LIMIT);
    expect(rows[rows.length - 1]?.kind).toBe('search');
    expect(rows.slice(0, -1).every((r) => r.kind === 'history')).toBe(true);
  });

  it('skips the search row for explicit-URL input', () => {
    const rows = build('https://github.com', [h('https://github.com/', 'GitHub')]);
    expect(rows.some((r) => r.kind === 'search')).toBe(false);
    expect(build('about:blank').length).toBe(0);
  });

  it('URL-encodes the query in the search row, preserving typed case', () => {
    const rows = build('C# tutorial');
    const search = rows.find((r) => r.kind === 'search');
    expect(search?.url).toBe(`${SEARCH_BASE}C%23%20tutorial`);
    expect(search?.title).toBe('C# tutorial');
  });
});

describe('matchRanges', () => {
  it('finds each token case-insensitively', () => {
    expect(matchRanges('GitHub Releases', 'git rel')).toEqual([
      { start: 0, end: 3 },
      { start: 7, end: 10 },
    ]);
  });

  it('merges overlapping token ranges', () => {
    expect(matchRanges('abcdef', 'abcd cdef')).toEqual([{ start: 0, end: 6 }]);
  });

  it('returns no ranges when nothing matches', () => {
    expect(matchRanges('example.com', 'zzz')).toEqual([]);
  });
});
