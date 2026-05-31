import { create } from 'zustand';
import {
  MODELS,
  PROVIDERS,
  DEFAULT_MODEL_KEY,
  customProviderId,
  findModel,
  isBuiltinProviderId,
  isProviderId,
  modelKey,
  type BuiltinProviderId,
  type CustomProviderInfo,
  type CustomProviderInput,
  type ModelDef,
  type ModelEntry,
  type OAuthFlow,
  type ProviderId,
  type ProviderStatus,
} from '../../../shared/providers';
import { toMessage } from '../../lib/toMessage';

/**
 * The provider/model/key store (docs/agentic-chat-v2-design.md §5.2). Split out
 * of the formerly-overloaded composer store so provider configuration has one
 * home. The model is **model-first**: callers select a {@link ModelEntry} by its
 * unique `key`, and `selectedProvider` + `selectedModel` are kept in sync for the
 * agent path that sends `{ provider, model }` on the wire. Live `/models` lists
 * merge over the static catalog per built-in provider; custom OpenAI-compatible
 * endpoints (custom:<id>) contribute their manually-listed models too. The
 * per-provider key/test/loading maps are keyed by {@link BuiltinProviderId} — the
 * `custom:${string}` half of {@link ProviderId} can't index a fixed Record — so
 * custom keys go through the dedicated set/clear actions instead.
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

  /** Flat catalog: static {@link MODELS} + each built-in's live list + custom models. */
  models: ModelEntry[];
  /** User-configured custom OpenAI-compatible endpoints (with key presence). */
  customProviders: CustomProviderInfo[];
  modelsLoadingByProvider: Record<BuiltinProviderId, boolean>;
  modelsErrorByProvider: Record<BuiltinProviderId, string | null>;

  /** Key presence per provider — built-ins and custom endpoints merged. */
  providerStatus: ProviderStatus[];
  statusChecked: boolean;
  statusError: string | null;

  // API-key editor for built-in providers (Settings → AI Providers).
  keyProvider: BuiltinProviderId;
  keyInput: string;
  keyBusy: boolean;
  keyError: string | null;

  testByProvider: Record<BuiltinProviderId, ConnectionTest>;

  // OAuth subscription connect flow (Settings → AI Providers → Connect with Claude).
  oauthBusy: boolean;
  oauthError: string | null;

  // Custom-endpoint add/remove form state.
  customBusy: boolean;
  customError: string | null;
};

type ProvidersActions = {
  /** Model-first selection — sets the key and syncs provider/model. */
  selectModel: (key: string) => void;
  refreshProviderStatus: () => Promise<void>;
  refreshModels: (provider: BuiltinProviderId, force?: boolean) => Promise<void>;
  selectKeyProvider: (id: BuiltinProviderId) => void;
  setKeyInput: (value: string) => void;
  saveProviderKey: () => Promise<void>;
  clearProviderKey: () => Promise<void>;
  testConnection: (provider: BuiltinProviderId) => Promise<void>;
  /** Whether the active model's provider has usable auth — key, keyless, or OAuth. */
  hasKeyForSelected: () => boolean;

  // OAuth login (docs/oauth-providers-design.md). `startOAuth` opens the browser and
  // returns the `flow` + authorize URL (fallback link). For 'manual-paste' the UI
  // shows a paste field → `completeOAuth(provider, pasted)`; for 'loopback' the UI
  // calls `completeOAuth(provider)` (no paste) which blocks until the browser
  // callback lands, and `cancelOAuth` aborts that wait.
  startOAuth: (provider: BuiltinProviderId) => Promise<{ flow: OAuthFlow; url: string } | null>;
  completeOAuth: (provider: BuiltinProviderId, pasted?: string) => Promise<boolean>;
  cancelOAuth: (provider: BuiltinProviderId) => Promise<void>;
  disconnectOAuth: (provider: BuiltinProviderId) => Promise<void>;

  // Custom OpenAI-compatible endpoints.
  loadCustomProviders: () => Promise<void>;
  addCustomProvider: (input: CustomProviderInput) => Promise<boolean>;
  removeCustomProvider: (id: string) => Promise<void>;
  setCustomKey: (id: string, key: string) => Promise<void>;
  clearCustomKey: (id: string) => Promise<void>;
};

function byProvider<T>(make: (id: BuiltinProviderId) => T): Record<BuiltinProviderId, T> {
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
function toEntries(provider: BuiltinProviderId, defs: ModelDef[]): ModelEntry[] {
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

/** Replace one built-in provider's slice of the flat catalog (grouping is in the UI). */
function mergeProviderModels(
  all: ModelEntry[],
  provider: BuiltinProviderId,
  entries: ModelEntry[],
): ModelEntry[] {
  return [...all.filter((m) => m.provider !== provider), ...entries];
}

/** Flatten custom endpoints into provider-tagged model entries. */
function customEntries(customs: CustomProviderInfo[]): ModelEntry[] {
  return customs.flatMap((c) =>
    c.models.map((m) => ({
      key: modelKey(customProviderId(c.id), m.id),
      id: m.id,
      label: m.label,
      provider: customProviderId(c.id),
      contextWindow: m.contextWindow,
      tools: m.tools ?? true,
    })),
  );
}

function customStatuses(customs: CustomProviderInfo[]): ProviderStatus[] {
  return customs.map((c) => ({ id: customProviderId(c.id), hasKey: c.hasKey }));
}

/** Re-project a fresh custom list onto models + providerStatus, keeping built-ins. */
function projectCustoms(
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

function loadSelectedKey(): string {
  try {
    return localStorage.getItem(SELECTED_KEY) || DEFAULT_MODEL_KEY;
  } catch {
    return DEFAULT_MODEL_KEY;
  }
}

function persistSelectedKey(key: string): void {
  try {
    localStorage.setItem(SELECTED_KEY, key);
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
function deriveSelection(key: string): { key: string; provider: ProviderId; model: string } {
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

const initial = deriveSelection(loadSelectedKey());

export const useProvidersStore = create<ProvidersState & ProvidersActions>((set, get) => ({
  selectedModelKey: initial.key,
  selectedProvider: initial.provider,
  selectedModel: initial.model,

  models: [...MODELS],
  customProviders: [],
  modelsLoadingByProvider: byProvider(() => false),
  modelsErrorByProvider: byProvider(() => null),

  providerStatus: PROVIDERS.map((p) => ({ id: p.id, hasKey: false })),
  statusChecked: false,
  statusError: null,

  keyProvider: initial.provider && isBuiltinProviderId(initial.provider) ? initial.provider : 'anthropic',
  keyInput: '',
  keyBusy: false,
  keyError: null,

  testByProvider: byProvider(() => ({ status: 'idle', message: null })),

  oauthBusy: false,
  oauthError: null,

  customBusy: false,
  customError: null,

  selectModel: (key) => {
    const entry = findModel(get().models, key);
    if (!entry) return;
    set({ selectedModelKey: key, selectedProvider: entry.provider, selectedModel: entry.id });
    persistSelectedKey(key);
    if (isBuiltinProviderId(entry.provider)) void get().refreshModels(entry.provider);
  },

  hasKeyForSelected: () => {
    const { providerStatus, selectedProvider } = get();
    const s = providerStatus.find((p) => p.id === selectedProvider);
    return !!s?.hasKey || !!s?.oauth;
  },

  refreshProviderStatus: async () => {
    try {
      const [list, customs] = await Promise.all([
        window.marudesk.invoke('secrets:list-providers'),
        window.marudesk.invoke('providers:list-custom'),
      ]);
      set((s) => ({
        statusChecked: true,
        statusError: null,
        ...projectCustoms({ models: s.models, providerStatus: list }, customs),
      }));
      for (const ps of list) {
        if (ps.hasKey && isBuiltinProviderId(ps.id)) void get().refreshModels(ps.id);
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

  startOAuth: async (provider) => {
    set({ oauthBusy: true, oauthError: null });
    try {
      return await window.marudesk.invoke('auth:oauth-start', provider);
    } catch (err) {
      set({ oauthError: toMessage(err) });
      return null;
    } finally {
      set({ oauthBusy: false });
    }
  },

  completeOAuth: async (provider, pasted) => {
    if (get().oauthBusy) return false;
    set({ oauthBusy: true, oauthError: null });
    try {
      await window.marudesk.invoke('auth:oauth-complete', { provider, pasted });
      await get().refreshProviderStatus();
      await get().refreshModels(provider, true);
      return true;
    } catch (err) {
      set({ oauthError: toMessage(err) });
      return false;
    } finally {
      set({ oauthBusy: false });
    }
  },

  // Not gated by oauthBusy — it must abort an in-flight loopback `completeOAuth`.
  cancelOAuth: async (provider) => {
    try {
      await window.marudesk.invoke('auth:oauth-cancel', provider);
    } catch (err) {
      set({ oauthError: toMessage(err) });
    }
  },

  disconnectOAuth: async (provider) => {
    if (get().oauthBusy) return;
    set({ oauthBusy: true, oauthError: null });
    try {
      await window.marudesk.invoke('auth:oauth-disconnect', provider);
      await get().refreshProviderStatus();
    } catch (err) {
      set({ oauthError: toMessage(err) });
    } finally {
      set({ oauthBusy: false });
    }
  },

  loadCustomProviders: async () => {
    try {
      const customs = await window.marudesk.invoke('providers:list-custom');
      set((s) => projectCustoms(s, customs));
    } catch (err) {
      set({ customError: toMessage(err) });
    }
  },

  addCustomProvider: async (input) => {
    if (get().customBusy) return false;
    set({ customBusy: true, customError: null });
    try {
      const customs = await window.marudesk.invoke('providers:add-custom', input);
      set((s) => projectCustoms(s, customs));
      return true;
    } catch (err) {
      set({ customError: toMessage(err) });
      return false;
    } finally {
      set({ customBusy: false });
    }
  },

  removeCustomProvider: async (id) => {
    if (get().customBusy) return;
    set({ customBusy: true, customError: null });
    try {
      const customs = await window.marudesk.invoke('providers:remove-custom', id);
      set((s) => projectCustoms(s, customs));
      // If the removed endpoint held the active model, fall back to the default.
      const s = get();
      if (!findModel(s.models, s.selectedModelKey)) {
        const def = findModel(MODELS, DEFAULT_MODEL_KEY)!;
        set({ selectedModelKey: def.key, selectedProvider: def.provider, selectedModel: def.id });
        persistSelectedKey(def.key);
      }
    } catch (err) {
      set({ customError: toMessage(err) });
    } finally {
      set({ customBusy: false });
    }
  },

  setCustomKey: async (id, key) => {
    const value = key.trim();
    if (value.length === 0) return;
    try {
      await window.marudesk.invoke('secrets:set-provider-key', customProviderId(id), value);
      await get().loadCustomProviders();
    } catch (err) {
      set({ customError: toMessage(err) });
    }
  },

  clearCustomKey: async (id) => {
    try {
      await window.marudesk.invoke('secrets:clear-provider-key', customProviderId(id));
      await get().loadCustomProviders();
    } catch (err) {
      set({ customError: toMessage(err) });
    }
  },
}));
