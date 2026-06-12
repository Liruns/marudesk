import { app } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { atomicWriteFile } from './fs-safe';
import { defineHandler } from './ipc/define-handler';
import { nonEmptyStr, obj, optStr, str } from './ipc/validate';
import { randomId } from '../shared/id';
import type { Bookmark, BookmarkInput } from '../shared/bookmarks';

/**
 * Bookmarks: a flat user-curated list, persisted under userData (trusted —
 * outside any workspace, like settings.ts and history.ts). Mutations are rare
 * (unlike history's per-navigation writes), so each one persists immediately
 * via an atomic write — no debounce to flush on quit.
 *
 * Only http(s) URLs can be bookmarked — internal schemes never enter the list.
 * Favicons are accepted only as self-contained `data:image/...` URLs (the form
 * NavState.favicon already carries) so the renderer can render them under its
 * strict `img-src 'self' data: blob:` CSP.
 */

let cache: Map<string, Bookmark> | null = null;
let loadPromise: Promise<Map<string, Bookmark>> | null = null;

function bookmarksFile(): string {
  return path.join(app.getPath('userData'), 'bookmarks.json');
}

/** Load the bookmark map (keyed by id), memoizing the in-flight promise. */
function load(): Promise<Map<string, Bookmark>> {
  if (cache) return Promise.resolve(cache);
  loadPromise ??= doLoad();
  return loadPromise;
}

async function doLoad(): Promise<Map<string, Bookmark>> {
  const map = new Map<string, Bookmark>();
  try {
    const raw = await fs.readFile(bookmarksFile(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (const e of parsed) {
        const b = parseStoredBookmark(e);
        if (b) map.set(b.id, b);
      }
    }
  } catch {
    // Missing or corrupt — start empty.
  }
  cache = map;
  return map;
}

/** Shape-check one persisted record; null drops it rather than throwing. */
function parseStoredBookmark(e: unknown): Bookmark | null {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
  const r = e as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id.length === 0) return null;
  if (typeof r.url !== 'string' || !/^https?:\/\//i.test(r.url)) return null;
  return {
    id: r.id,
    url: r.url,
    title: typeof r.title === 'string' ? r.title : '',
    faviconUrl: isSafeFavicon(r.faviconUrl) ? r.faviconUrl : undefined,
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : 0,
    folder:
      typeof r.folder === 'string' && r.folder.length > 0 ? r.folder : undefined,
  };
}

function isSafeFavicon(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith('data:image/');
}

async function persist(): Promise<void> {
  if (!cache) return;
  try {
    await atomicWriteFile(bookmarksFile(), JSON.stringify([...cache.values()]));
  } catch {
    // Best-effort — never throw on the mutation path.
  }
}

/**
 * Drop the in-memory cache so the next load reads the now-active profile's
 * file. Mutations persist synchronously, so unlike history there is no pending
 * debounce to flush — but keep the name parallel for the main.ts teardown.
 */
export function flushAndResetBookmarksForProfile(): void {
  cache = null;
  loadPromise = null;
}

/** Newest first — the panel's display order. */
export async function listBookmarks(): Promise<Bookmark[]> {
  const map = await load();
  return [...map.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export async function addBookmark(input: BookmarkInput): Promise<Bookmark> {
  if (!/^https?:\/\//i.test(input.url)) {
    throw new Error('only http(s) pages can be bookmarked');
  }
  const map = await load();
  // One bookmark per URL: re-adding updates the existing record in place.
  const existing = [...map.values()].find((b) => b.url === input.url);
  const bookmark: Bookmark = {
    id: existing?.id ?? randomId('bm'),
    url: input.url,
    title: input.title || existing?.title || '',
    faviconUrl: isSafeFavicon(input.faviconUrl)
      ? input.faviconUrl
      : existing?.faviconUrl,
    createdAt: existing?.createdAt ?? Date.now(),
    folder: input.folder ?? existing?.folder,
  };
  map.set(bookmark.id, bookmark);
  await persist();
  return bookmark;
}

export async function removeBookmark(id: string): Promise<boolean> {
  const map = await load();
  if (!map.delete(id)) return false;
  await persist();
  return true;
}

/**
 * Star-toggle for the current tab's URL: adds when absent (returns the new
 * bookmark), removes when present (returns null).
 */
export async function toggleBookmark(
  input: BookmarkInput,
): Promise<Bookmark | null> {
  const map = await load();
  const existing = [...map.values()].find((b) => b.url === input.url);
  if (existing) {
    map.delete(existing.id);
    await persist();
    return null;
  }
  return addBookmark(input);
}

/** Validate an untrusted renderer payload into a {@link BookmarkInput}. */
function parseBookmarkInput(payload: unknown): BookmarkInput {
  const p = obj(payload);
  return {
    url: nonEmptyStr(p.url, 'url'),
    title: str(p.title ?? '', 'title'),
    faviconUrl: optStr(p.faviconUrl, 'faviconUrl'),
    folder: optStr(p.folder, 'folder'),
  };
}

export function registerBookmarkHandlers(): void {
  defineHandler('bookmarks:list', () => listBookmarks());
  defineHandler('bookmarks:add', ([payload]) =>
    addBookmark(parseBookmarkInput(payload)),
  );
  defineHandler('bookmarks:remove', ([payload]) =>
    removeBookmark(str(obj(payload).id, 'id')),
  );
  defineHandler('bookmarks:toggle', ([payload]) =>
    toggleBookmark(parseBookmarkInput(payload)),
  );
}
