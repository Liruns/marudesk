import { create } from 'zustand';
import type {
  CapturePayload,
  ProposeResult,
} from '../../../shared/composer';
import { toMessage } from '../../lib/toMessage';
import type { Capture } from '../../../shared/capture';
import {
  PROVIDERS,
  type ModelDef,
  type ProviderId,
  type ProviderStatus,
  getProvider,
} from '../../../shared/providers';
import { useWebPageStore } from '../browser/store';
import { usePatchStore } from '../patch/store';

type ComposerTab = 'captures' | 'composer';

const DEFAULT_PROVIDER: ProviderId = 'anthropic';

function defaultModel(provider: ProviderId): string {
  return getProvider(provider).defaultModelId;
}

function staticModels(provider: ProviderId): ModelDef[] {
  return getProvider(provider).models;
}

type ComposerState = {
  tab: ComposerTab;
  prompt: string;
  proposing: boolean;
  lastResult: ProposeResult | null;

  selectedProvider: ProviderId;
  selectedModel: string;
  modelByProvider: Record<ProviderId, string>;

  // Dynamic model lists fetched from each provider's /v1/models endpoint.
  // Falls back to the static catalog from shared/providers.ts when unknown.
  modelsByProvider: Record<ProviderId, ModelDef[]>;
  modelsLoadingByProvider: Record<ProviderId, boolean>;
  modelsErrorByProvider: Record<ProviderId, string | null>;

  providerStatus: ProviderStatus[];
  statusChecked: boolean;
  statusError: string | null;

  // API-key editor state (rendered inline in the Settings → AI Providers panel).
  keyProvider: ProviderId;
  keyInput: string;
  keyBusy: boolean;
  keyError: string | null;
};

type ComposerActions = {
  setTab: (tab: ComposerTab) => void;
  setPrompt: (prompt: string) => void;

  setSelectedProvider: (id: ProviderId) => void;
  setSelectedModel: (id: string) => void;

  refreshProviderStatus: () => Promise<void>;
  refreshModels: (provider: ProviderId, force?: boolean) => Promise<void>;

  selectKeyProvider: (id: ProviderId) => void;
  setKeyInput: (value: string) => void;
  saveProviderKey: () => Promise<void>;
  clearProviderKey: () => Promise<void>;

  propose: () => Promise<void>;
  clearLastResult: () => void;
};

function toPayload(capture: Capture): CapturePayload {
  return {
    id: capture.id,
    tagName: capture.tagName,
    selector: capture.selector,
    text: capture.text,
    attributes: capture.attributes,
    url: capture.url,
    // Forwarded only when present (DevTools-originated captures); the LLM
    // context builder folds them into the per-capture block.
    outerHTML: capture.outerHTML,
    computedStyle: capture.computedStyle,
  };
}

function hasKeyFor(
  list: ProviderStatus[],
  provider: ProviderId,
): boolean {
  return !!list.find((s) => s.id === provider)?.hasKey;
}

const initialModelByProvider = PROVIDERS.reduce(
  (acc, p) => {
    acc[p.id] = p.defaultModelId;
    return acc;
  },
  {} as Record<ProviderId, string>,
);

const initialModelsByProvider = PROVIDERS.reduce(
  (acc, p) => {
    acc[p.id] = p.models;
    return acc;
  },
  {} as Record<ProviderId, ModelDef[]>,
);

const initialModelsLoading = PROVIDERS.reduce(
  (acc, p) => {
    acc[p.id] = false;
    return acc;
  },
  {} as Record<ProviderId, boolean>,
);

const initialModelsError = PROVIDERS.reduce(
  (acc, p) => {
    acc[p.id] = null;
    return acc;
  },
  {} as Record<ProviderId, string | null>,
);

export const useComposerStore = create<ComposerState & ComposerActions>(
  (set, get) => ({
    tab: 'captures',
    prompt: '',
    proposing: false,
    lastResult: null,

    selectedProvider: DEFAULT_PROVIDER,
    selectedModel: defaultModel(DEFAULT_PROVIDER),
    modelByProvider: initialModelByProvider,

    modelsByProvider: initialModelsByProvider,
    modelsLoadingByProvider: initialModelsLoading,
    modelsErrorByProvider: initialModelsError,

    providerStatus: PROVIDERS.map((p) => ({ id: p.id, hasKey: false })),
    statusChecked: false,
    statusError: null,

    keyProvider: DEFAULT_PROVIDER,
    keyInput: '',
    keyBusy: false,
    keyError: null,

    setTab: (tab) => set({ tab }),
    setPrompt: (prompt) => set({ prompt }),

    setSelectedProvider: (id) => {
      set((state) => ({
        selectedProvider: id,
        selectedModel: state.modelByProvider[id] ?? defaultModel(id),
      }));
      void get().refreshModels(id);
    },

    setSelectedModel: (id) =>
      set((state) => ({
        selectedModel: id,
        modelByProvider: { ...state.modelByProvider, [state.selectedProvider]: id },
      })),

    refreshProviderStatus: async () => {
      try {
        const list = await window.marudesk.invoke(
          'secrets:list-providers',
        );
        set({
          providerStatus: list,
          statusChecked: true,
          statusError: null,
        });
        // Kick off model fetches for providers that have keys.
        for (const ps of list) {
          if (ps.hasKey) void get().refreshModels(ps.id);
        }
      } catch (err) {
        set({
          statusChecked: true,
          statusError: toMessage(err),
        });
      }
    },

    refreshModels: async (provider, force = false) => {
      const { modelsLoadingByProvider, modelsByProvider } = get();
      if (!force && modelsLoadingByProvider[provider]) return;
      set((s) => ({
        modelsLoadingByProvider: {
          ...s.modelsLoadingByProvider,
          [provider]: true,
        },
        modelsErrorByProvider: { ...s.modelsErrorByProvider, [provider]: null },
      }));
      try {
        const models = await window.marudesk.invoke(
          'providers:list-models',
          provider,
        );
        if (Array.isArray(models) && models.length > 0) {
          set((s) => ({
            modelsByProvider: { ...s.modelsByProvider, [provider]: models },
            modelsLoadingByProvider: {
              ...s.modelsLoadingByProvider,
              [provider]: false,
            },
          }));
          // If the currently-selected model isn't in the new list, switch to
          // the first listed model so the dropdown doesn't show a stale value.
          const state = get();
          if (state.selectedProvider === provider) {
            const stillValid = models.some((m) => m.id === state.selectedModel);
            if (!stillValid) {
              const next = models[0].id;
              set({
                selectedModel: next,
                modelByProvider: {
                  ...state.modelByProvider,
                  [provider]: next,
                },
              });
            }
          }
        } else {
          set((s) => ({
            modelsLoadingByProvider: {
              ...s.modelsLoadingByProvider,
              [provider]: false,
            },
          }));
        }
      } catch (err) {
        // Keep whatever we have (static fallback) and surface the error.
        const fallback = modelsByProvider[provider] ?? staticModels(provider);
        set((s) => ({
          modelsByProvider: { ...s.modelsByProvider, [provider]: fallback },
          modelsLoadingByProvider: {
            ...s.modelsLoadingByProvider,
            [provider]: false,
          },
          modelsErrorByProvider: {
            ...s.modelsErrorByProvider,
            [provider]: toMessage(err),
          },
        }));
      }
    },

    selectKeyProvider: (id) =>
      set({ keyProvider: id, keyInput: '', keyError: null }),

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
        await window.marudesk.invoke(
          'secrets:set-provider-key',
          keyProvider,
          value,
        );
        await get().refreshProviderStatus();
        // After a successful save the cache is invalidated server-side, so
        // force a fresh fetch.
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
        await window.marudesk.invoke(
          'secrets:clear-provider-key',
          keyProvider,
        );
        await get().refreshProviderStatus();
      } catch (err) {
        set({ keyError: toMessage(err) });
      } finally {
        set({ keyBusy: false });
      }
    },

    propose: async () => {
      const {
        prompt,
        proposing,
        selectedProvider,
        selectedModel,
        providerStatus,
      } = get();
      if (proposing) return;
      const text = prompt.trim();
      if (text.length === 0) {
        set({
          lastResult: {
            ok: false,
            reason: 'enter a prompt before proposing',
          },
        });
        return;
      }
      if (!hasKeyFor(providerStatus, selectedProvider)) {
        set({
          lastResult: {
            ok: false,
            reason: `no API key configured for ${getProvider(selectedProvider).label}`,
          },
        });
        return;
      }
      const webPage = useWebPageStore.getState();
      const selectedIds = webPage.selectedCaptureIds;
      const selected = webPage.captures.filter((c) => selectedIds.has(c.id));
      if (selected.length === 0) {
        set({
          lastResult: {
            ok: false,
            reason: 'select at least one capture from the Captures tab',
          },
        });
        return;
      }

      set({ proposing: true, lastResult: null });
      try {
        const result = await window.marudesk.invoke(
          'llm:propose-patch',
          {
            provider: selectedProvider,
            model: selectedModel,
            prompt: text,
            captures: selected.map(toPayload),
          },
        );
        set({ lastResult: result });
        if (result.ok && result.ops.length > 0) {
          usePatchStore.getState().setOps(result.ops);
        }
      } catch (err) {
        set({
          lastResult: {
            ok: false,
            reason: toMessage(err),
          },
        });
      } finally {
        set({ proposing: false });
      }
    },

    clearLastResult: () => set({ lastResult: null }),
  }),
);
