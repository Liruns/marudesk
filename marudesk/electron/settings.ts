import { app } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { atomicWriteFile } from './fs-safe';
import { defineHandler } from './ipc/define-handler';
import {
  DEFAULT_SETTINGS,
  sanitizeSettings,
  type AppSettings,
} from '../shared/settings';

/**
 * Settings persistence. Stored as JSON under the OS userData dir (trusted —
 * outside any workspace, so the fs-safe workspace validator doesn't apply).
 * Reads go through `sanitizeSettings` so a hand-edited or corrupt file can
 * never feed malformed values into the app. Writes are atomic (tmp + rename).
 */

let cache: AppSettings | null = null;

/**
 * Drop the in-memory settings cache so the next {@link getSettings} reload reads
 * from whatever userData dir is now active — used by the live profile switch
 * (electron/main.ts) after `app.setPath` repoints userData.
 */
export function resetSettingsCacheForProfile(): void {
  cache = null;
}

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

async function load(): Promise<AppSettings> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(settingsFile(), 'utf8');
    cache = sanitizeSettings(JSON.parse(raw));
  } catch {
    // Missing or unreadable/corrupt — start from defaults (deep-cloned so the
    // shared DEFAULT_SETTINGS constant can never be mutated through the cache).
    cache = structuredClone(DEFAULT_SETTINGS);
  }
  void cleanupStaleTmp();
  return cache;
}

/**
 * Best-effort sweep of tmp files orphaned by a crash between write and rename
 * (the randomized suffix means they're never reused, so they'd otherwise
 * accumulate). Runs once, lazily, on first settings load.
 */
let tmpCleaned = false;
async function cleanupStaleTmp(): Promise<void> {
  if (tmpCleaned) return;
  tmpCleaned = true;
  try {
    const dir = app.getPath('userData');
    const entries = await fs.readdir(dir);
    await Promise.all(
      entries
        .filter((n) => n.startsWith('settings.json.marudesk-tmp-'))
        .map((n) => fs.unlink(path.join(dir, n)).catch(() => undefined)),
    );
  } catch {
    // Never block settings load on cleanup.
  }
}

async function persist(next: AppSettings): Promise<void> {
  cache = next;
  await atomicWriteFile(settingsFile(), JSON.stringify(next, null, 2));
}

/**
 * Read settings once at startup (so the renderer can request them immediately).
 * Safe to call before handlers are registered.
 */
export function getSettings(): Promise<AppSettings> {
  return load();
}

/**
 * The last-loaded settings, synchronously. Returns the defaults until the first
 * `load()` resolves (which happens at startup). Used by sync call sites that
 * can't await — e.g. the address-bar/new-tab URL resolver picking the search
 * engine. Never mutate the result.
 */
export function getSettingsSync(): AppSettings {
  // Clone the fallback so a sync caller can never mutate the shared constant
  // (matches load()/reset()), even though today's only caller just reads.
  return cache ?? structuredClone(DEFAULT_SETTINGS);
}

/** Broadcast captured at handler registration so main-side writers can notify renderers. */
let broadcastFn: ((settings: AppSettings) => void) | null = null;

/**
 * Serializes all writes (settings:set IPC + main-side patchSettings) so concurrent
 * read-modify-write calls can't clobber each other — each runs after the previous
 * has persisted (and updated the cache), so it merges onto the latest state.
 */
let writeChain: Promise<unknown> = Promise.resolve();

/**
 * Merge a partial over the current settings, persist, and broadcast — the
 * main-process twin of the `settings:set` IPC, for code that needs to write a
 * setting itself (e.g. the agent loop persisting a per-tool "Allow always",
 * v6 §W7). Goes through the same sanitize + atomic-write + broadcast path, and is
 * serialized against every other write so a fire-and-forget call can't race.
 */
export async function patchSettings(partial: unknown): Promise<AppSettings> {
  const run = async (): Promise<AppSettings> => {
    const current = await load();
    const next = sanitizeSettings(mergeDeep(current, partial), current);
    await persist(next);
    broadcastFn?.(next);
    return next;
  };
  const result = writeChain.then(run, run);
  // Keep the chain alive even if a write rejects (don't wedge later writes).
  writeChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function registerSettingsHandlers(deps: {
  broadcast: (settings: AppSettings) => void;
}): void {
  broadcastFn = deps.broadcast;

  defineHandler('settings:get', () => load());

  // Delegate to patchSettings so the renderer's writes share the same serialized
  // sanitize + atomic-write + broadcast path as main-side writers.
  defineHandler('settings:set', ([partial]) => patchSettings(partial));

  defineHandler('settings:reset', async () => {
    const next = structuredClone(DEFAULT_SETTINGS);
    await persist(next);
    deps.broadcast(next);
    return next;
  });
}

/**
 * Shallow-by-section merge: the renderer sends a partial like
 * `{ appearance: { theme: 'light' } }`; we merge each known section so other
 * fields in that section are preserved before sanitize fills/clamps the rest.
 */
function mergeDeep(base: AppSettings, partial: unknown): unknown {
  if (!partial || typeof partial !== 'object') return base;
  const p = partial as Record<string, unknown>;
  const section = (
    key:
      | 'appearance'
      | 'editor'
      | 'terminal'
      | 'devtools'
      | 'browser'
      | 'window'
      | 'lanes'
      | 'agent'
      | 'pcControl'
      | 'server'
      | 'storage',
  ) => {
    const incoming = p[key];
    if (!incoming || typeof incoming !== 'object') return base[key];
    return { ...base[key], ...(incoming as Record<string, unknown>) };
  };
  return {
    version: 1,
    appearance: section('appearance'),
    editor: section('editor'),
    terminal: section('terminal'),
    devtools: section('devtools'),
    browser: section('browser'),
    window: section('window'),
    lanes: section('lanes'),
    agent: section('agent'),
    pcControl: section('pcControl'),
    server: section('server'),
    storage: section('storage'),
  };
}
