import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { BookmarkEntry, BookmarkInput } from '../../shared/bookmarks';

/**
 * Electron-free bookmarks store core: load/validate/mutate/persist against one
 * JSON file. The Electron wiring (userData path, IPC handlers, renderer push)
 * lives in ./bookmarks; keeping the core pure-Node lets the harness
 * (bookmarks-harness.ts) exercise add/remove/update/persist round-trips under
 * plain `node --experimental-strip-types`, mirroring native-menu-harness.
 *
 * The list is kept newest-first (adds prepend), so `list()` needs no re-sort
 * and equal-millisecond `createdAt` values can't shuffle the order.
 */

export type BookmarksStore = {
  list: () => Promise<BookmarkEntry[]>;
  /** Add a bookmark for `input.url`; returns the existing entry if already bookmarked. */
  add: (input: BookmarkInput) => Promise<BookmarkEntry>;
  /** Remove by id. False for an unknown id. */
  remove: (id: string) => Promise<boolean>;
  /** Rename by id. Null for an unknown id. */
  update: (id: string, patch: { title?: string }) => Promise<BookmarkEntry | null>;
  /** Find by exact URL (the star button's "is this page bookmarked" check). */
  findByUrl: (url: string) => Promise<BookmarkEntry | null>;
};

/** Validate one untrusted persisted record into a BookmarkEntry, or null. */
function parseEntry(value: unknown): BookmarkEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.id !== 'string' || rec.id.length === 0) return null;
  if (typeof rec.url !== 'string' || rec.url.length === 0) return null;
  return {
    id: rec.id,
    url: rec.url,
    title: typeof rec.title === 'string' ? rec.title : '',
    faviconUrl:
      typeof rec.faviconUrl === 'string' && rec.faviconUrl.length > 0
        ? rec.faviconUrl
        : undefined,
    createdAt: typeof rec.createdAt === 'number' ? rec.createdAt : 0,
  };
}

/** Parse a persisted bookmarks file body. Corrupt/foreign shapes yield []. */
export function parseBookmarks(raw: string): BookmarkEntry[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: BookmarkEntry[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      const entry = parseEntry(item);
      if (entry && !seen.has(entry.id)) {
        seen.add(entry.id);
        out.push(entry);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Atomic write: exclusive-create sibling temp + rename, mirroring
 * fs-safe.atomicWriteFile. Re-implemented here (it's 10 lines) rather than
 * imported because fs-safe's import chain isn't extension-qualified, which
 * would break the plain-Node harness run.
 */
async function atomicWrite(abs: string, content: string): Promise<void> {
  const tmp = `${abs}.marudesk-tmp-${randomBytes(6).toString('hex')}`;
  const fh = await fs.open(tmp, 'wx');
  try {
    await fh.writeFile(content, 'utf8');
  } finally {
    await fh.close();
  }
  try {
    await fs.rename(tmp, abs);
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
}

function newId(): string {
  return `bm-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

/**
 * Create a store bound to one JSON file. `file` is resolved lazily on first
 * use (the Electron caller can't call app.getPath at import time);
 * `onChange` fires after every successful mutation (the renderer push hook).
 */
export function createBookmarksStore(
  file: () => string,
  onChange?: (list: BookmarkEntry[]) => void,
): BookmarksStore {
  let cache: BookmarkEntry[] | null = null;
  let loadPromise: Promise<BookmarkEntry[]> | null = null;
  // Mutations queue behind one another so two near-simultaneous IPC calls
  // can't interleave their read-modify-write against the same array/file.
  let chain: Promise<unknown> = Promise.resolve();

  async function doLoad(): Promise<BookmarkEntry[]> {
    let entries: BookmarkEntry[] = [];
    try {
      entries = parseBookmarks(await fs.readFile(file(), 'utf8'));
    } catch {
      // Missing or unreadable — start empty.
    }
    cache = entries;
    return entries;
  }

  // Memoize the in-flight first load so concurrent callers share one array
  // (the same pattern as electron/history.ts).
  function load(): Promise<BookmarkEntry[]> {
    if (cache) return Promise.resolve(cache);
    loadPromise ??= doLoad();
    return loadPromise;
  }

  async function persist(entries: BookmarkEntry[]): Promise<void> {
    const target = file();
    await fs.mkdir(path.dirname(target), { recursive: true }).catch(() => undefined);
    await atomicWrite(target, JSON.stringify(entries));
  }

  function mutate<T>(op: (entries: BookmarkEntry[]) => Promise<T>): Promise<T> {
    const next = chain.then(load).then(op);
    // Failures must not wedge the queue — the next mutation starts fresh.
    chain = next.catch(() => undefined);
    return next;
  }

  return {
    list: async () => [...(await load())],

    add: (input) =>
      mutate(async (entries) => {
        const existing = entries.find((e) => e.url === input.url);
        if (existing) return existing;
        const entry: BookmarkEntry = {
          id: newId(),
          url: input.url,
          title: input.title,
          faviconUrl: input.faviconUrl,
          createdAt: Date.now(),
        };
        entries.unshift(entry);
        await persist(entries);
        onChange?.([...entries]);
        return entry;
      }),

    remove: (id) =>
      mutate(async (entries) => {
        const index = entries.findIndex((e) => e.id === id);
        if (index < 0) return false;
        entries.splice(index, 1);
        await persist(entries);
        onChange?.([...entries]);
        return true;
      }),

    update: (id, patch) =>
      mutate(async (entries) => {
        const entry = entries.find((e) => e.id === id);
        if (!entry) return null;
        if (patch.title !== undefined) entry.title = patch.title;
        await persist(entries);
        onChange?.([...entries]);
        return entry;
      }),

    findByUrl: async (url) => (await load()).find((e) => e.url === url) ?? null,
  };
}
