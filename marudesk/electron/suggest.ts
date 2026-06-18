import { defineHandler } from './ipc/define-handler';
import { str } from './ipc/validate';
import { allHistoryEntries } from './history';
import { listBookmarks } from './browser/bookmarks';
import { resolveAddressBarInput, searchBaseFor } from './browser/url';
import { getSettingsSync } from './settings';
import { buildSuggestions } from '../shared/suggest';

/**
 * Address-bar dropdown suggestions (`browser:suggest`). Matching and ranking
 * run here in main — where the history and bookmark stores live — but the
 * policy itself is the pure, unit-tested ranker in shared/suggest.ts. The
 * trailing "search the web" row uses the configured default search engine,
 * the same wiring address-bar navigation resolves through (browser/url.ts).
 */
export function registerSuggestHandlers(): void {
  defineHandler('browser:suggest', async ([raw]) => {
    const query = str(raw, 'query');
    if (!query.trim()) return [];
    const [history, bookmarks] = await Promise.all([
      allHistoryEntries(),
      listBookmarks(),
    ]);
    const searchBase = searchBaseFor(getSettingsSync().browser.searchEngine);
    // A real destination (not a search) → offer a leading "Go to <host>" row.
    const resolved = resolveAddressBarInput(query, searchBase);
    const navUrl =
      resolved && resolved !== 'about:blank' && !resolved.startsWith(searchBase)
        ? resolved
        : undefined;
    return buildSuggestions({ query, history, bookmarks, searchBase, navUrl });
  });
}
