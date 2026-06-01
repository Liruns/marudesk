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

export function registerSettingsHandlers(deps: {
  broadcast: (settings: AppSettings) => void;
}): void {
  defineHandler('settings:get', () => load());

  defineHandler('settings:set', async ([partial]) => {
    const current = await load();
    // Deep-merge the partial over current and re-validate everything.
    const next = sanitizeSettings(mergeDeep(current, partial), current);
    await persist(next);
    deps.broadcast(next);
    return next;
  });

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
    key: 'appearance' | 'terminal' | 'devtools' | 'browser' | 'agent',
  ) => {
    const incoming = p[key];
    if (!incoming || typeof incoming !== 'object') return base[key];
    return { ...base[key], ...(incoming as Record<string, unknown>) };
  };
  return {
    version: 1,
    appearance: section('appearance'),
    terminal: section('terminal'),
    devtools: section('devtools'),
    browser: section('browser'),
    agent: section('agent'),
  };
}
