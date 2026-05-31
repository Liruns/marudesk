import { create } from 'zustand';
import {
  MODELS,
  PROVIDERS,
  DEFAULT_MODEL_KEY,
  findModel,
  getProvider,
  modelKey,
  type ModelDef,
  type ModelEntry,
  type ProviderId,
  type ProviderStatus,
} from '../../../shared/providers';
import { toMessage } from '../../lib/toMessage';

/**
 * The provider/model/key store (docs/agentic-chat-v2-design.md §5.2). Split out
 * of the formerly-overloaded composer store so provider configuration has one
 * home. The model is **model-first**: callers select a {@link ModelEntry} by its
 * unique `key`, and `selectedProvider` + `selectedModel` are kept in sync for the
 * agent/propose paths that send `{ provider, model }` on the wire. Live `/models`
 * lists merge over the static catalog per provider.
 */

const SELECTED_KEY = 'marudesk.providers.selectedModelKey';

type ConnectionTest = {
  status: 'idle' | 'testing' | 'ok' | 'error';
  message: string | null;
};

type ProvidersState = {
  /** The model-first selection (globally-unique key). */
  selectedModelKey: string;
  /** Derived from the selected entry, kept in sync for the `{provider,model}` wire. */
  selectedProvider: ProviderId;
  selectedModel: string;

  /** Flat catalog: the static {@link MODELS} with each provider's live list merged in. */
  models: ModelEntry[];
  modelsLoadingByProvider: Record<ProviderId, boolean>;
  modelsErrorByProvider: Record<ProviderId, string | null>;

  providerStatus: ProviderStatus[];
  statusChecked: boolean;
  statusError: string | null;

  // API-key editor (Settings → AI Providers).
  keyProvider: ProviderId;
  keyInput: string;
  keyBusy: boolean;
  keyError: string | null;

  testByProvider: Record<ProviderId, ConnectionTest>;
};

type ProvidersActions = {
  /** Model-first selection — sets the key and syncs provider/model. */
  selectModel: (key: string) => void;
  /** Provider-first compat (used by the legacy Quick-patch composer + status bar). */
  setSelectedProvider: (id: ProviderId) => void;
  setSelectedModel: (modelId: string) => void;
  refreshProviderStatus: () => Promise<void>;
  refreshModels: (provider: ProviderId, force?: boolean) => Promise<void>;
  selectKeyProvider: (id: ProviderId) => void;
  setKeyInput: (value: string) => void;
  saveProviderKey: () => Promise<void>;
  clearProviderKey: () => Promise<void>;
  testConnection: (provider: ProviderId) => Promise<void>;
  /** Whether the active model's provider has a usable key (keyless = always true). */
  hasKeyForSelected: () => boolean;
};

function byProvider<T>(make: (id: ProviderId) => T): Record<ProviderId, T> {
  return PROVIDERS.reduce(
    (acc, p) => {
      acc[p.id] = make(p.id);
      return acc;
    },
    {} as Record<ProviderId, T>,
  );
}

/** Convert a provider's live `/models` list into provider-tagged entries, keeping
 * the static catalog's contextWindow/tool flags where the id matches. */
function toEntries(provider: ProviderId, defs: ModelDef[]): ModelEntry[] {
  return defs.map((d) => {
    const stat = MODELS.find((m) => m.provider === provider && m.id === d.id);
    return {
      key: modelKey(provider, d.id),
      id: d.id,
      label: d.label,
      provider,
      contextWindow: stat?.contextWindow,
      tools: stat?.tools ?? true,
    };
  });
}

/** Replace one provider's slice of the flat catalog (grouping is done in the UI). */
function mergeProviderModels(all: ModelEntry[], provider: ProviderId, entries: ModelEntry[]): ModelEntry[] {
  return [...all.filter((m) => m.provider !== provider), ...entries];
}

function loadSelectedKey(): string {
  try {
    const raw = localStorage.getItem(SELECTED_KEY);
    if (raw && findModel(MODELS, raw)) return raw;
  } catch {
    // localStorage unavailable — use the default.
  }
  return DEFAULT_MODEL_KEY;
}

function persistSelectedKey(key: string): void {
  try {
    localStorage.setItem(SELECTED_KEY, key);
  } catch {
    // best-effort
  }
}

const initialKey = loadSelectedKey();
const initialEntry = findModel(MODELS, initialKey) ?? findModel(MODELS, DEFAULT_MODEL_KEY)!;

export const useProvidersStore = create<ProvidersState & ProvidersActions>((set, get) => ({
  selectedModelKey: initialEntry.key,
  selectedProvider: initialEntry.provider,
  selectedModel: initialEntry.id,

  models: [...MODELS],
  modelsLoadingByProvider: byProvider(() => false),
  modelsErrorByProvider: byProvider(() => null),

  providerStatus: PROVIDERS.map((p) => ({ id: p.id, hasKey: false })),
  statusChecked: false,
  statusError: null,

  keyProvider: initialEntry.provider,
  keyInput: '',
  keyBusy: false,
  keyError: null,

  testByProvider: byProvider(() => ({ status: 'idle', message: null })),

  selectModel: (key) => {
    const entry = findModel(get().models, key);
    if (!entry) return;
    set({ selectedModelKey: key, selectedProvider: entry.provider, selectedModel: entry.id });
    persistSelectedKey(key);
    void get().refreshModels(entry.provider);
  },

  setSelectedProvider: (id) => {
    const cur = get();
    // Keep the current model if it already belongs to this provider; else its default.
    const nextModel = cur.selectedProvider === id ? cur.selectedModel : getProvider(id).defaultModelId;
    const key = modelKey(id, nextModel);
    set({ selectedProvider: id, selectedModel: nextModel, selectedModelKey: key });
    persistSelectedKey(key);
    void get().refreshModels(id);
  },

  setSelectedModel: (modelId) => {
    const key = modelKey(get().selectedProvider, modelId);
    set({ selectedModel: modelId, selectedModelKey: key });
    persistSelectedKey(key);
  },

  hasKeyForSelected: () => {
    const { providerStatus, selectedProvider } = get();
    return !!providerStatus.find((s) => s.id === selectedProvider)?.hasKey;
  },

  refreshProviderStatus: async () => {
    try {
      const list = await window.marudesk.invoke('secrets:list-providers');
      set({ providerStatus: list, statusChecked: true, statusError: null });
      for (const ps of list) {
        if (ps.hasKey) void get().refreshModels(ps.id);
      }
    } catch (err) {
      set({ statusChecked: true, statusError: toMessage(err) });
    }
  },

  refreshModels: async (provider, force = false) => {
    const { modelsLoadingByProvider } = get();
    if (!force && modelsLoadingByProvider[provider]) return;
    set((s) => ({
      modelsLoadingByProvider: { ...s.modelsLoadingByProvider, [provider]: true },
      modelsErrorByProvider: { ...s.modelsErrorByProvider, [provider]: null },
    }));
    try {
      const defs = await window.marudesk.invoke('providers:list-models', provider);
      if (Array.isArray(defs) && defs.length > 0) {
        set((s) => ({
          models: mergeProviderModels(s.models, provider, toEntries(provider, defs)),
          modelsLoadingByProvider: { ...s.modelsLoadingByProvider, [provider]: false },
        }));
        // If the active model vanished from a refreshed list, fall back sensibly.
        const s = get();
        if (s.selectedProvider === provider && !findModel(s.models, s.selectedModelKey)) {
          const next = s.models.find((m) => m.provider === provider) ?? s.models[0];
          if (next) {
            set({ selectedModelKey: next.key, selectedProvider: next.provider, selectedModel: next.id });
            persistSelectedKey(next.key);
          }
        }
      } else {
        set((s) => ({ modelsLoadingByProvider: { ...s.modelsLoadingByProvider, [provider]: false } }));
      }
    } catch (err) {
      set((s) => ({
        modelsLoadingByProvider: { ...s.modelsLoadingByProvider, [provider]: false },
        modelsErrorByProvider: { ...s.modelsErrorByProvider, [provider]: toMessage(err) },
      }));
    }
  },

  selectKeyProvider: (id) => set({ keyProvider: id, keyInput: '', keyError: null }),

  setKeyInput: (keyInput) => set({ keyInput, keyError: null }),

  saveProviderKey: async () => {
    const { keyInput, keyBusy, keyProvider } = get();
    if (keyBusy) return;
    const value = keyInput.trim();
    if (value.length === 0) {
      set({ keyError: 'Paste an API key first.' });
      return;
    }
    set({ keyBusy: true, keyError: null });
    try {
      await window.marudesk.invoke('secrets:set-provider-key', keyProvider, value);
      await get().refreshProviderStatus();
      await get().refreshModels(keyProvider, true);
      set({ keyInput: '' });
    } catch (err) {
      set({ keyError: toMessage(err) });
    } finally {
      set({ keyBusy: false });
    }
  },

  clearProviderKey: async () => {
    const { keyBusy, keyProvider } = get();
    if (keyBusy) return;
    set({ keyBusy: true, keyError: null });
    try {
      await window.marudesk.invoke('secrets:clear-provider-key', keyProvider);
      await get().refreshProviderStatus();
      set((s) => ({
        testByProvider: { ...s.testByProvider, [keyProvider]: { status: 'idle', message: null } },
      }));
    } catch (err) {
      set({ keyError: toMessage(err) });
    } finally {
      set({ keyBusy: false });
    }
  },

  testConnection: async (provider) => {
    if (get().testByProvider[provider]?.status === 'testing') return;
    set((s) => ({
      testByProvider: { ...s.testByProvider, [provider]: { status: 'testing', message: null } },
    }));
    try {
      const defs = await window.marudesk.invoke('providers:list-models', provider);
      set((s) => ({
        models: mergeProviderModels(s.models, provider, toEntries(provider, defs)),
        testByProvider: {
          ...s.testByProvider,
          [provider]: {
            status: 'ok',
            message: `Connected — ${defs.length} model${defs.length === 1 ? '' : 's'} available.`,
          },
        },
      }));
    } catch (err) {
      set((s) => ({
        testByProvider: { ...s.testByProvider, [provider]: { status: 'error', message: toMessage(err) } },
      }));
    }
  },
}));
