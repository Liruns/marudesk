import { app } from 'electron';
import path from 'node:path';
import { defineHandler } from '../ipc/define-handler';
import { obj, optStr, str } from '../ipc/validate';
import { getHost } from './state';
import { createBookmarksStore } from './bookmarks-core';
import type { BookmarkEntry } from '../../shared/bookmarks';

/**
 * Bookmarks for the embedded browser: persisted under userData (trusted —
 * outside any workspace, like history.json), mutated via the `bookmarks:*`
 * invokes and pushed to the renderer on the `browser:bookmarks` event whenever
 * the set changes (the downloads push pattern). The store mechanics live in
 * ./bookmarks-core so the harness can exercise them without Electron.
 *
 * Package leaf-consumer: imports only ./state (for getHost) — no sibling cycle.
 */

const store = createBookmarksStore(
  () => path.join(app.getPath('userData'), 'bookmarks.json'),
  pushBookmarks,
);

function pushBookmarks(list: BookmarkEntry[]): void {
  const host = getHost();
  if (!host || host.isDestroyed()) return;
  host.webContents.send('browser:bookmarks', list);
}

/** The current bookmark list (newest first) — address-bar suggestions input. */
export function listBookmarks(): Promise<BookmarkEntry[]> {
  return store.list();
}

export function registerBookmarkHandlers(): void {
  defineHandler('bookmarks:list', () => store.list());

  // Each mutation resolves the fresh list so the caller reprojects without a
  // follow-up fetch (the providers:add-custom / mcp:set-enabled pattern); the
  // `browser:bookmarks` push covers every other listener.
  defineHandler('bookmarks:add', async ([payload]) => {
    const p = obj(payload);
    await store.add({
      url: str(p.url, 'url'),
      title: str(p.title, 'title'),
      faviconUrl: optStr(p.faviconUrl, 'faviconUrl'),
    });
    return store.list();
  });

  defineHandler('bookmarks:remove', async ([payload]) => {
    await store.remove(str(obj(payload).id, 'id'));
    return store.list();
  });

  defineHandler('bookmarks:update', async ([payload]) => {
    const p = obj(payload);
    await store.update(str(p.id, 'id'), { title: str(p.title, 'title') });
    return store.list();
  });
}
