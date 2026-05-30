import { getActive, getActiveTabId, getHost, type TabRecord } from './state';

/**
 * In-page find (Ctrl+F) for the embedded browser. Thin wrapper over Chromium's
 * `webContents.findInPage` / `stopFindInPage`; the match-count results arrive
 * asynchronously on the `found-in-page` event, which `handleFoundInPage`
 * forwards to the renderer's find bar.
 *
 * Find targets the ACTIVE web tab only — the find bar lives in the single-view
 * BrowserCanvas (it has no place in the grid, like DevTools). Results from a
 * tab that is no longer active are dropped so a late event can't update the bar
 * for the wrong page.
 *
 * Package leaf-consumer: imports only ./state — no sibling cycle.
 */

export type FindOptions = {
  forward?: boolean;
  findNext?: boolean;
  matchCase?: boolean;
};

/** Result subset we forward to the renderer (the full Electron.Result has more). */
type FoundInPageResult = {
  activeMatchOrdinal: number;
  matches: number;
  finalUpdate: boolean;
};

export function findInActive(text: string, options: FindOptions): void {
  const active = getActive();
  // An empty query would throw in Chromium; the renderer guards too, but keep
  // main robust against a bad payload.
  if (!active || !active.view || !text) return;
  active.view.webContents.findInPage(text, options);
}

export function stopFindInActive(
  action: 'clearSelection' | 'keepSelection' | 'activateSelection',
): void {
  const active = getActive();
  if (!active || !active.view) return;
  active.view.webContents.stopFindInPage(action);
}

/**
 * Forward a `found-in-page` result to the renderer's find bar — but only for the
 * active tab, since that's the tab the (single, shared) bar is bound to.
 */
export function handleFoundInPage(
  rec: TabRecord,
  result: FoundInPageResult,
): void {
  if (rec.id !== getActiveTabId()) return;
  const host = getHost();
  if (!host || host.isDestroyed()) return;
  host.webContents.send('browser:found-in-page', {
    activeMatchOrdinal: result.activeMatchOrdinal,
    matches: result.matches,
    finalUpdate: result.finalUpdate,
  });
}
