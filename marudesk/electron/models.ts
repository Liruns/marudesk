import {
  isProviderId,
  getProvider,
  type ModelDef,
  type ProviderId,
} from '../shared/providers';
import { defineHandler } from './ipc/define-handler';
import { getProviderApiKey } from './secrets';
import { DRIVERS } from './providers';

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

export async function getModelsFor(provider: ProviderId): Promise<ModelDef[]> {
  const def = getProvider(provider);
  const cached = cache.get(provider);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.models;
  }
  let apiKey: string | null = null;
  try {
    apiKey = await getProviderApiKey(provider);
  } catch {
    // Decryption issues — fall back to static.
  }
  if (!apiKey) {
    return def.models;
  }
  try {
    const dynamic = await DRIVERS[provider].listModels(apiKey);
    const merged = dedupeMerge(def.models, dynamic);
    cache.set(provider, { models: merged, fetchedAt: Date.now() });
    return merged;
  } catch (err) {
    console.warn(`[models] failed to fetch ${provider}:`, (err as Error).message);
    return def.models;
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
