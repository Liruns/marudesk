import { create } from 'zustand';
import type { CapturePayload, ProposeResult } from '../../../shared/composer';
import { toMessage } from '../../lib/toMessage';
import type { Capture } from '../../../shared/capture';
import { getProvider } from '../../../shared/providers';
import { useWebPageStore } from '../browser/store';
import { usePatchStore } from '../patch/store';
import { useProvidersStore } from '../providers/store';

/**
 * The composer store now owns only the one-shot "Quick patch" surface: the
 * prompt, the in-flight flag, and the last result. Provider/model/key selection
 * moved to {@link useProvidersStore} (docs/agentic-chat-v2-design.md §5.2), which
 * the agent and this Quick-patch path both read from — one source of truth.
 */

type ComposerTab = 'agent' | 'captures' | 'composer';

type ComposerState = {
  tab: ComposerTab;
  prompt: string;
  proposing: boolean;
  lastResult: ProposeResult | null;
};

type ComposerActions = {
  setTab: (tab: ComposerTab) => void;
  setPrompt: (prompt: string) => void;
  propose: () => Promise<void>;
  clearLastResult: () => void;
};

/** Map a renderer {@link Capture} to the lean payload the LLM context builder takes. */
export function toPayload(capture: Capture): CapturePayload {
  if (capture.kind === 'console-error') {
    return {
      kind: 'console-error',
      id: capture.id,
      url: capture.url,
      message: capture.message,
      stack: capture.stack,
      source: capture.source,
    };
  }
  return {
    kind: 'element',
    id: capture.id,
    url: capture.url,
    tagName: capture.tagName,
    selector: capture.selector,
    text: capture.text,
    attributes: capture.attributes,
    // Forwarded only when present (DevTools-originated captures); the LLM
    // context builder folds them into the per-capture block.
    outerHTML: capture.outerHTML,
    computedStyle: capture.computedStyle,
  };
}

export const useComposerStore = create<ComposerState & ComposerActions>((set, get) => ({
  tab: 'agent',
  prompt: '',
  proposing: false,
  lastResult: null,

  setTab: (tab) => set({ tab }),
  setPrompt: (prompt) => set({ prompt }),

  propose: async () => {
    const { prompt, proposing } = get();
    if (proposing) return;
    const text = prompt.trim();
    if (text.length === 0) {
      set({ lastResult: { ok: false, reason: 'enter a prompt before proposing' } });
      return;
    }
    const providers = useProvidersStore.getState();
    const provider = providers.selectedProvider;
    const model = providers.selectedModel;
    if (!providers.hasKeyForSelected()) {
      set({
        lastResult: { ok: false, reason: `no API key configured for ${getProvider(provider).label}` },
      });
      return;
    }
    const webPage = useWebPageStore.getState();
    const selectedIds = webPage.selectedCaptureIds;
    const selected = webPage.captures.filter((c) => selectedIds.has(c.id));
    if (selected.length === 0) {
      set({ lastResult: { ok: false, reason: 'select at least one capture from the Captures tab' } });
      return;
    }

    set({ proposing: true, lastResult: null });
    try {
      const result = await window.marudesk.invoke('llm:propose-patch', {
        provider,
        model,
        prompt: text,
        captures: selected.map(toPayload),
      });
      set({ lastResult: result });
      if (result.ok && result.ops.length > 0) {
        usePatchStore.getState().setOps(result.ops);
      }
    } catch (err) {
      set({ lastResult: { ok: false, reason: toMessage(err) } });
    } finally {
      set({ proposing: false });
    }
  },

  clearLastResult: () => set({ lastResult: null }),
}));
