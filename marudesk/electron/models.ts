import {
  isProviderId,
  isBuiltinProviderId,
  getProvider,
  type ModelDef,
  type ProviderId,
} from '../shared/providers';
import { defineHandler } from './ipc/define-handler';
import { getProviderApiKey } from './secrets';
import { DRIVERS } from './providers';
import { ProviderAuthError } from './providers/tool';
import { ensureModelsDevLoaded, getModelsDevFor } from './models-dev';

type CacheEntry = {
  models: ModelDef[];
  fetchedAt: number;
};

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const cache = new Map<ProviderId, CacheEntry>();

function dedupeMerge(staticModels: ModelDef[], dynamic: ModelDef[]): ModelDef[] {
  const map = new Map<string, ModelDef>();
  for (const m of staticModels) map.set(m.id, m);
  // Dynamic wins on duplicates — fresher labels and ordering.
  const ordered: ModelDef[] = [];
  for (const m of dynamic) {
    map.set(m.id, m);
    ordered.push(m);
  }
  // Append any static-only entries not in dynamic for resilience.
  for (const m of staticModels) {
    if (!ordered.some((x) => x.id === m.id)) ordered.push(m);
  }
  // Deduplicate while preserving order.
  const seen = new Set<string>();
  const result: ModelDef[] = [];
  for (const m of ordered) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    result.push(map.get(m.id) ?? m);
  }
  return result;
}

/**
 * The static seed enriched with the models.dev catalog (newly-released models
 * not yet in the seed). Returned synchronously — `getModelsDevFor` never blocks
 * on its 2MB fetch — and used both as the no-key fallback and as the base the
 * live per-key list merges over. Only built-in providers have a models.dev
 * mapping; `custom:<id>` endpoints get just their static seed.
 */
function seedWithModelsDev(provider: ProviderId, seed: ModelDef[]): ModelDef[] {
  if (!isBuiltinProviderId(provider)) return seed;
  return dedupeMerge(seed, getModelsDevFor(provider));
}

export async function getModelsFor(provider: ProviderId): Promise<ModelDef[]> {
  const def = getProvider(provider);
  // Warm the models.dev cache on first use (best-effort, non-blocking).
  void ensureModelsDevLoaded();
  const cached = cache.get(provider);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.models;
  }
  const withModelsDev = seedWithModelsDev(provider, def.models);
  let apiKey: string | null = null;
  try {
    apiKey = await getProviderApiKey(provider);
  } catch {
    // Decryption issues — fall back to the seed (+ models.dev).
  }
  if (!apiKey && !def.keyless) {
    return withModelsDev;
  }
  try {
    const dynamic = await DRIVERS[provider].listModels(apiKey ?? '');
    // Merge order: static seed → models.dev → live. The live per-key list still
    // wins on conflicts; models.dev only contributes ids the seed lacks.
    const merged = dedupeMerge(withModelsDev, dynamic);
    cache.set(provider, { models: merged, fetchedAt: Date.now() });
    return merged;
  } catch (err) {
    // A rejected credential is a real, actionable error — surface it so the
    // picker doesn't silently show stale models for a bad key and so the
    // Settings "Test connection" button can report failure. Transient/network
    // errors still fall back to the static catalog (+ models.dev).
    if (err instanceof ProviderAuthError) throw err;
    console.warn(`[models] failed to fetch ${provider}:`, (err as Error).message);
    return withModelsDev;
  }
}

export function invalidateModelsCache(provider?: ProviderId): void {
  if (provider) cache.delete(provider);
  else cache.clear();
}

export function registerModelsHandlers(): void {
  defineHandler('providers:list-models', ([provider]) => {
    if (!isProviderId(provider)) throw new Error('invalid provider');
    return getModelsFor(provider);
  });
}
