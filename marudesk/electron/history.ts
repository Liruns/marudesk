import { app } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { atomicWriteFile } from './fs-safe';
import { defineHandler } from './ipc/define-handler';
import type { HistoryEntry } from '../shared/history';

/**
 * Browsing history: visited URLs, persisted under userData (trusted — outside
 * any workspace, like settings.ts), used to power the address bar's inline
 * autocomplete. Writes are atomic and debounced (navigation can fire often);
 * the list is capped and pruned by frecency so the file can't grow unbounded.
 *
 * Only http(s) URLs are recorded — about:blank, error pages, and internal
 * schemes never enter history.
 */

const MAX_ENTRIES = 2000;
const QUERY_LIMIT = 8;
const RECENT_LIMIT = 8;
const SAVE_DEBOUNCE_MS = 1500;

let cache: Map<string, HistoryEntry> | null = null;
let loadPromise: Promise<Map<string, HistoryEntry>> | null = null;
let saveTimer: NodeJS.Timeout | null = null;

function historyFile(): string {
  return path.join(app.getPath('userData'), 'history.json');
}

/**
 * Load the history map, memoizing the in-flight promise so concurrent
 * first-callers (a did-navigate visit racing a page-title-updated, or a query
 * at startup) share ONE Map. Without this each builds its own and the last
 * assignment clobbers the others' mutations — silently dropping a visit.
 */
function load(): Promise<Map<string, HistoryEntry>> {
  if (cache) return Promise.resolve(cache);
  loadPromise ??= doLoad();
  return loadPromise;
}

async function doLoad(): Promise<Map<string, HistoryEntry>> {
  const map = new Map<string, HistoryEntry>();
  try {
    const raw = await fs.readFile(historyFile(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (const e of parsed) {
        if (e && typeof e === 'object' && typeof (e as HistoryEntry).url === 'string') {
          const entry = e as Record<string, unknown>;
          const url = entry.url as string;
          map.set(url, {
            url,
            title: typeof entry.title === 'string' ? entry.title : '',
            visitCount:
              typeof entry.visitCount === 'number' && entry.visitCount > 0
                ? Math.floor(entry.visitCount)
                : 1,
            lastVisit:
              typeof entry.lastVisit === 'number' ? entry.lastVisit : 0,
          });
        }
      }
    }
  } catch {
    // Missing or corrupt — start empty.
  }
  cache = map;
  return map;
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void persist();
  }, SAVE_DEBOUNCE_MS);
}

async function persist(): Promise<void> {
  if (!cache) return;
  let entries = [...cache.values()];
  if (entries.length > MAX_ENTRIES) {
    // Drop the least-frecent entries past the cap.
    entries.sort((a, b) => frecency(b) - frecency(a));
    entries = entries.slice(0, MAX_ENTRIES);
    cache = new Map(entries.map((e) => [e.url, e]));
  }
  try {
    await atomicWriteFile(historyFile(), JSON.stringify(entries));
  } catch {
    // Best-effort — never throw on the navigation path.
  }
}

/** visitCount dominates; lastVisit breaks ties (newer ranks higher). */
function frecency(e: HistoryEntry): number {
  return e.visitCount * 1e13 + e.lastVisit;
}

/**
 * Flush any pending debounced save to the CURRENT profile's history.json, then
 * drop the in-memory cache so the next load reads the now-active profile's file.
 * Used by the live profile switch — call this BEFORE `app.setPath` repoints
 * userData so the pending write still lands in the old profile.
 */
export async function flushAndResetHistoryForProfile(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    await persist();
  }
  cache = null;
  loadPromise = null;
}

/** Record a top-level visit. http(s) only; no-op for internal schemes. */
export function recordVisit(url: string, title: string): void {
  if (!/^https?:\/\//i.test(url)) return;
  void load().then((map) => {
    const existing = map.get(url);
    if (existing) {
      existing.visitCount += 1;
      existing.lastVisit = Date.now();
      if (title) existing.title = title;
    } else {
      map.set(url, { url, title: title || '', visitCount: 1, lastVisit: Date.now() });
    }
    scheduleSave();
  });
}

/** Update the title for an already-recorded URL (page-title-updated). */
export function recordTitle(url: string, title: string): void {
  if (!title || !/^https?:\/\//i.test(url)) return;
  void load().then((map) => {
    const e = map.get(url);
    if (e && e.title !== title) {
      e.title = title;
      scheduleSave();
    }
  });
}

function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
}

/**
 * Query for autocomplete: prefix matches (on the scheme-stripped URL) first —
 * those are what inline-complete — then other substring matches, each ranked by
 * frecency. Capped at {@link QUERY_LIMIT}.
 */
async function query(raw: string): Promise<HistoryEntry[]> {
  const q = raw.trim().toLowerCase();
  if (!q) return [];
  const map = await load();
  const prefix: HistoryEntry[] = [];
  const substring: HistoryEntry[] = [];
  for (const e of map.values()) {
    const stripped = stripScheme(e.url).toLowerCase();
    if (stripped.startsWith(q) || e.url.toLowerCase().startsWith(q)) {
      prefix.push(e);
    } else if (
      e.url.toLowerCase().includes(q) ||
      e.title.toLowerCase().includes(q)
    ) {
      substring.push(e);
    }
  }
  prefix.sort((a, b) => frecency(b) - frecency(a));
  substring.sort((a, b) => frecency(b) - frecency(a));
  return [...prefix, ...substring].slice(0, QUERY_LIMIT);
}

/**
 * The most-visited entries by frecency, for the browser stage's empty-state
 * quick links (DevTools' / Chrome's "most visited" tiles). No query — just the
 * top of the frecency ranking, capped at {@link RECENT_LIMIT}.
 */
async function recent(): Promise<HistoryEntry[]> {
  const map = await load();
  return [...map.values()].sort((a, b) => frecency(b) - frecency(a)).slice(0, RECENT_LIMIT);
}

export function registerHistoryHandlers(): void {
  defineHandler('history:query', ([raw]) =>
    query(typeof raw === 'string' ? raw : ''),
  );
  defineHandler('history:recent', () => recent());
}
