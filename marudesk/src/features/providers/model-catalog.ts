import {
  MODELS,
  PROVIDERS,
  DEFAULT_MODEL_KEY,
  customProviderId,
  findModel,
  isBuiltinProviderId,
  isProviderId,
  mergeInferredModelCapabilities,
  modelKey,
  type BuiltinProviderId,
  type CustomProviderInfo,
  type ModelDef,
  type ModelEntry,
  type ProviderId,
  type ProviderStatus,
} from '../../../shared/providers';
import type { ProvidersState } from './store';

/**
 * Pure model-catalog + selection-persistence helpers for the providers store.
 * They build provider-tagged {@link ModelEntry} lists (static catalog merged with
 * live `/models` + custom endpoints) and read/write the persisted selection /
 * recents / favorites in localStorage. No store state — split out of store.ts so
 * it holds the Zustand wiring only.
 */

const SELECTED_KEY = 'marudesk.providers.selectedModelKey';

export function byProvider<T>(make: (id: BuiltinProviderId) => T): Record<BuiltinProviderId, T> {
  return PROVIDERS.reduce(
    (acc, p) => {
      acc[p.id] = make(p.id);
      return acc;
    },
    {} as Record<BuiltinProviderId, T>,
  );
}

/** Convert a built-in provider's live `/models` list into provider-tagged entries,
 * keeping the static catalog's contextWindow/tool flags where the id matches. */
export function toEntries(provider: BuiltinProviderId, defs: ModelDef[]): ModelEntry[] {
  return defs.map((d) => {
    const stat = MODELS.find((m) => m.provider === provider && m.id === d.id);
    return mergeInferredModelCapabilities({
      key: modelKey(provider, d.id),
      id: d.id,
      label: d.label,
      provider,
      contextWindow: stat?.contextWindow,
      tools: stat?.tools,
      vision: stat?.vision,
      reasoning: stat?.reasoning,
      imageGeneration: stat?.imageGeneration,
      imageEdit: stat?.imageEdit,
      imageTransport: stat?.imageTransport,
      videoGeneration: stat?.videoGeneration,
      videoEdit: stat?.videoEdit,
      videoTransport: stat?.videoTransport,
    });
  });
}

/** Replace one built-in provider's slice of the flat catalog (grouping is in the UI). */
export function mergeProviderModels(
  all: ModelEntry[],
  provider: BuiltinProviderId,
  entries: ModelEntry[],
): ModelEntry[] {
  return [...all.filter((m) => m.provider !== provider), ...entries];
}

/** Flatten custom endpoints into provider-tagged model entries. */
function customEntries(customs: CustomProviderInfo[]): ModelEntry[] {
  return customs.flatMap((c) =>
    c.models.map((m) => {
      const provider = customProviderId(c.id);
      return mergeInferredModelCapabilities({
        key: modelKey(provider, m.id),
        id: m.id,
        label: m.label,
        provider,
        contextWindow: m.contextWindow,
        tools: m.tools,
      });
    }),
  );
}

function customStatuses(customs: CustomProviderInfo[]): ProviderStatus[] {
  return customs.map((c) => ({ id: customProviderId(c.id), hasKey: c.hasKey }));
}

/** Re-project a fresh custom list onto models + providerStatus, keeping built-ins. */
export function projectCustoms(
  s: Pick<ProvidersState, 'models' | 'providerStatus'>,
  customs: CustomProviderInfo[],
): Pick<ProvidersState, 'customProviders' | 'models' | 'providerStatus'> {
  return {
    customProviders: customs,
    models: [...s.models.filter((m) => isBuiltinProviderId(m.provider)), ...customEntries(customs)],
    providerStatus: [
      ...s.providerStatus.filter((p) => isBuiltinProviderId(p.id)),
      ...customStatuses(customs),
    ],
  };
}

/**
 * Selection keys that were removed/renamed in the catalog, mapped to their
 * replacement. Applied on load so an existing persisted pick doesn't keep
 * failing: e.g. `openai-codex:gpt-5` 400s on the ChatGPT Codex backend ("not
 * supported when using Codex with a ChatGPT account"), so remap it to the
 * working `-codex` slug. The raw-key fallback in {@link deriveSelection} would
 * otherwise resurrect the dead slug verbatim.
 */
const REMOVED_KEY_MIGRATIONS: Record<string, string> = {
  'openai-codex:gpt-5': 'openai-codex:gpt-5-codex',
  // xAI retired grok-2/3/4* and grok-code-fast-1 on 2026-05-15 (requests now
  // redirect to grok-4.3) — remap dead persisted picks to the live models.
  'xai:grok-4': 'xai:grok-4.3',
  'xai:grok-3': 'xai:grok-4.3',
  'xai:grok-3-mini': 'xai:grok-4.3',
  'xai:grok-code-fast-1': 'xai:grok-build-0.1',
};

export function loadSelectedKey(): string {
  try {
    const raw = localStorage.getItem(SELECTED_KEY) || DEFAULT_MODEL_KEY;
    return REMOVED_KEY_MIGRATIONS[raw] ?? raw;
  } catch {
    return DEFAULT_MODEL_KEY;
  }
}

export function persistSelectedKey(key: string): void {
  try {
    localStorage.setItem(SELECTED_KEY, key);
  } catch {
    // best-effort
  }
}

export const RECENT_KEY = 'marudesk.providers.recentModelKeys';
export const FAVORITES_KEY = 'marudesk.providers.favoriteModelKeys';
export const MAX_RECENT = 6;

/** Load a persisted list of model keys (recents / favorites); tolerant of bad JSON. */
export function loadKeyList(storageKey: string): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

export function persistKeyList(storageKey: string, list: string[]): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(list));
  } catch {
    // best-effort
  }
}

/**
 * Resolve a stored key to a concrete selection. A catalog hit wins; otherwise
 * (a custom or live-only model not yet loaded) derive provider/model from the key
 * itself (`modelKey` = `${provider}:${id}`, split at the last colon) so a custom
 * pick survives a restart before the custom list arrives; else fall back.
 */
export function deriveSelection(key: string): { key: string; provider: ProviderId; model: string } {
  const entry = findModel(MODELS, key);
  if (entry) return { key, provider: entry.provider, model: entry.id };
  const i = key.lastIndexOf(':');
  if (i > 0) {
    const provider = key.slice(0, i);
    const model = key.slice(i + 1);
    if (isProviderId(provider) && model.length > 0) return { key, provider, model };
  }
  const def = findModel(MODELS, DEFAULT_MODEL_KEY)!;
  return { key: def.key, provider: def.provider, model: def.id };
}
