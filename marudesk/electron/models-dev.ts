import { app } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { atomicWriteFile } from './fs-safe';
import type { BuiltinProviderId, ModelDef } from '../shared/providers';

/**
 * models.dev catalog freshness source. The community-maintained
 * https://models.dev/api.json is an unauthenticated, frequently-updated dump of
 * every provider's models with capability metadata. We fold it in **between** a
 * provider's static seed and its live per-key /models fetch (electron/models.ts)
 * so a newly-released model shows up in the picker the day it lands — before we
 * cut a release that updates the static seed, and even for OAuth-only/keyless
 * connections that never hit a live /models endpoint.
 *
 * This is strictly best-effort enrichment: the fetch is a ~2MB payload, so the
 * accessor `getModelsFor` calls ({@link getModelsDevFor}) NEVER blocks on the
 * network — it returns whatever is cached (possibly empty) and kicks off a
 * background refresh. Nothing here throws; on any network/parse failure we keep
 * serving the last good data, or `{}` if we never got any.
 */

const API_URL = 'https://models.dev/api.json';
const FETCH_TIMEOUT_MS = 6_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — the catalog moves slowly.

/** Our built-in provider ids that have a clean models.dev counterpart key. */
const PROVIDER_KEYS: Partial<Record<BuiltinProviderId, string>> = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google',
  xai: 'xai',
  zai: 'zai',
  opencode: 'opencode',
  // Skipped: ollama (local), openai-codex / google-caa (OAuth-only subscription
  // backends) — no clean models.dev mapping.
};

type CatalogMap = Partial<Record<BuiltinProviderId, ModelDef[]>>;
type DiskCache = { fetchedAt: number; data: CatalogMap };

/** The shape of one model entry in the models.dev api.json (fields we read). */
type RawModel = {
  id?: unknown;
  name?: unknown;
  tool_call?: unknown;
  modalities?: { input?: unknown; output?: unknown };
  release_date?: unknown;
  last_updated?: unknown;
};
type RawProvider = { models?: Record<string, RawModel> };
type RawCatalog = Record<string, RawProvider | undefined>;

// In-memory cache (module-scoped). `fetchedAt: 0` means "never loaded".
let memory: CatalogMap = {};
let fetchedAt = 0;
// Memoized in-flight refresh so concurrent callers share one fetch.
let refreshPromise: Promise<void> | null = null;

function cacheFile(): string {
  return path.join(app.getPath('userData'), 'models-dev-cache.json');
}

function isStale(): boolean {
  return Date.now() - fetchedAt >= CACHE_TTL_MS;
}

/**
 * Keep chat/text + tool-capable models; drop image/audio/video/embedding-only
 * entries. We require `tool_call === true` (the agent needs tools) and, when the
 * catalog records output modalities, that 'text' is one of them. Missing
 * modality info is treated as text-capable (resilient to schema gaps).
 */
function isUsableModel(m: RawModel): boolean {
  if (m.tool_call !== true) return false;
  const output = m.modalities?.output;
  if (Array.isArray(output)) {
    return output.some((x) => x === 'text');
  }
  return true; // No modality info — assume text.
}

/** Newest-first when a date field is present; otherwise input order is kept. */
function releaseTime(m: RawModel): number {
  const raw = m.last_updated ?? m.release_date;
  if (typeof raw !== 'string') return 0;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? 0 : t;
}

function mapProviderModels(provider: RawProvider | undefined): ModelDef[] {
  const models = provider?.models;
  if (!models || typeof models !== 'object') return [];
  const entries = Object.values(models)
    .filter((m): m is RawModel => !!m && typeof m === 'object')
    .filter(isUsableModel)
    .filter((m): m is RawModel & { id: string } => typeof m.id === 'string');
  // Sort newest-ish first when dates are available; entries without a date sort
  // last but otherwise retain their relative order (stable sort).
  entries.sort((a, b) => releaseTime(b) - releaseTime(a));
  return entries.map((m) => ({
    id: m.id,
    label: typeof m.name === 'string' && m.name ? m.name : m.id,
  }));
}

function parseCatalog(raw: unknown): CatalogMap {
  if (!raw || typeof raw !== 'object') return {};
  const catalog = raw as RawCatalog;
  const out: CatalogMap = {};
  for (const [provider, key] of Object.entries(PROVIDER_KEYS) as [
    BuiltinProviderId,
    string,
  ][]) {
    const models = mapProviderModels(catalog[key]);
    if (models.length) out[provider] = models;
  }
  return out;
}

/** Fetch + parse the live catalog. Returns null on any network/parse failure. */
async function fetchCatalog(): Promise<CatalogMap | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(API_URL, { signal: controller.signal });
    if (!resp.ok) return null;
    const json: unknown = await resp.json();
    return parseCatalog(json);
  } catch {
    // Network error, abort/timeout, or invalid JSON — fall back to cache.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Load the on-disk cache into memory once (no-op once we already have data). */
async function loadDiskCache(): Promise<void> {
  if (fetchedAt > 0) return;
  try {
    const rawText = await fs.readFile(cacheFile(), 'utf8');
    const parsed = JSON.parse(rawText) as DiskCache;
    if (
      parsed &&
      typeof parsed.fetchedAt === 'number' &&
      parsed.data &&
      typeof parsed.data === 'object'
    ) {
      memory = parsed.data;
      fetchedAt = parsed.fetchedAt;
    }
  } catch {
    // Missing or corrupt — stay empty until the first network refresh.
  }
}

async function persistDiskCache(): Promise<void> {
  try {
    const payload: DiskCache = { fetchedAt, data: memory };
    await atomicWriteFile(cacheFile(), JSON.stringify(payload));
  } catch {
    // Best-effort — never throw on the enrichment path.
  }
}

/**
 * Refresh from disk (once) then network if stale. Memoized so concurrent
 * callers share a single pass; never throws.
 */
async function doRefresh(): Promise<void> {
  await loadDiskCache();
  if (!isStale()) return;
  const fresh = await fetchCatalog();
  if (fresh) {
    memory = fresh;
    fetchedAt = Date.now();
    await persistDiskCache();
  }
  // On failure we keep the existing `memory`/`fetchedAt`; a stale-but-present
  // cache still beats nothing, and we'll retry on the next call once TTL lapses.
}

function refreshInBackground(): void {
  if (refreshPromise) return;
  refreshPromise = doRefresh().finally(() => {
    refreshPromise = null;
  });
  // Detach: callers must not block on this.
  void refreshPromise;
}

/**
 * Warm the cache once (load disk, refresh from network if stale). Awaitable, for
 * a startup nudge; callers that can't block should use {@link getModelsDevFor}.
 */
export async function ensureModelsDevLoaded(): Promise<void> {
  if (refreshPromise) return refreshPromise;
  refreshInBackground();
  return refreshPromise ?? Promise.resolve();
}

/**
 * The currently-cached models.dev list for one of our providers — returned
 * **synchronously** (possibly empty) so callers never block on the 2MB fetch. A
 * background refresh is triggered when the cache is missing or stale; its result
 * is picked up by the next call. Providers without a models.dev mapping (ollama,
 * the OAuth-only ids) always return `[]`.
 */
export function getModelsDevFor(provider: BuiltinProviderId): ModelDef[] {
  if (!(provider in PROVIDER_KEYS)) return [];
  if (fetchedAt === 0 || isStale()) refreshInBackground();
  return memory[provider] ?? [];
}
