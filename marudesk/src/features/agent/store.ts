import { create } from 'zustand';
import type { AgentAnswers, AgentChatState } from '../../../shared/agent';
import { emptyAgentChatState } from '../../../shared/agent';
import { toMessage } from '../../lib/toMessage';
import { useWebPageStore } from '../browser/store';
import { toPayload } from '../composer/store';
import { useProvidersStore } from '../providers/store';
import { useTabsStore } from '../tabs/store';

/**
 * Renderer projection of the agentic AI Chat (docs/agentic-chat-design.md §8).
 * main owns the authoritative state; this store mirrors the latest `agent:event`
 * snapshot and exposes thin action wrappers over the `agent:*` invokes. Provider/
 * model/key selection is reused from the composer store — the agent shares the
 * same configured providers rather than duplicating that machinery.
 */

type AgentState = {
  chat: AgentChatState;
  draft: string;
  /** Local pre-turn error (no key / no workspace / send rejected). */
  localError: string | null;
};

type AgentActions = {
  setDraft: (v: string) => void;
  /** Replace the projection from an `agent:event` snapshot. */
  ingest: (chat: AgentChatState) => void;
  /** Pull the current state on mount (catches up after the panel was unmounted). */
  hydrate: () => Promise<void>;
  send: () => Promise<void>;
  abort: () => Promise<void>;
  answer: (callId: string, answers: AgentAnswers) => Promise<void>;
  approve: (callId: string, approved: boolean) => Promise<void>;
  acceptEdit: (editId: string) => Promise<void>;
  revertEdit: (editId: string) => Promise<void>;
  resetChat: () => Promise<void>;
};

function activeWebTabId(): string | undefined {
  const { activeTabId, tabs } = useTabsStore.getState();
  const active = tabs.find((t) => t.id === activeTabId);
  return active?.kind === 'web' ? active.id : undefined;
}

export const useAgentStore = create<AgentState & AgentActions>((set, get) => ({
  chat: emptyAgentChatState(),
  draft: '',
  localError: null,

  setDraft: (draft) => set({ draft }),

  ingest: (chat) => set({ chat }),

  hydrate: async () => {
    try {
      const chat = await window.marudesk.invoke('agent:snapshot');
      set({ chat });
    } catch {
      // best-effort; the next agent:event will populate it
    }
  },

  send: async () => {
    const { draft, chat } = get();
    const text = draft.trim();
    if (text.length === 0) return;
    if (chat.status === 'thinking' || chat.status === 'working' || chat.status === 'waiting_for_user') {
      return;
    }

    const providers = useProvidersStore.getState();
    const provider = providers.selectedProvider;
    const model = providers.selectedModel;
    const hasKey = providers.hasKeyForSelected();
    // AI Chat no longer requires an open workspace — file tools just degrade to a
    // friendly "open a folder" message in main, while browser/page tools and a
    // plain conversation work without one.
    if (!hasKey) {
      set({ localError: `No API key configured for ${provider}. Add one in Settings.` });
      return;
    }

    const web = useWebPageStore.getState();
    const captures = web.captures
      .filter((c) => web.selectedCaptureIds.has(c.id))
      .map(toPayload);

    set({ localError: null, draft: '' });
    try {
      const res = await window.marudesk.invoke('agent:send', {
        provider,
        model,
        prompt: text,
        captures,
        tabId: activeWebTabId(),
      });
      if (!res.ok) set({ localError: res.reason, draft: text });
    } catch (err) {
      set({ localError: toMessage(err), draft: text });
    }
  },

  abort: async () => {
    const turnId = get().chat.turnId;
    if (!turnId) return;
    try {
      await window.marudesk.invoke('agent:abort', { turnId });
    } catch {
      // ignore — the next snapshot reflects the real state
    }
  },

  answer: async (callId, answers) => {
    const turnId = get().chat.turnId;
    if (!turnId) return;
    try {
      await window.marudesk.invoke('agent:respond', { turnId, callId, answers });
    } catch {
      // ignore
    }
  },

  approve: async (callId, approved) => {
    const turnId = get().chat.turnId;
    if (!turnId) return;
    try {
      await window.marudesk.invoke('agent:approve-tool', { turnId, callId, approved });
    } catch {
      // ignore
    }
  },

  acceptEdit: async (editId) => {
    try {
      await window.marudesk.invoke('agent:accept-edit', { editId });
    } catch {
      // ignore
    }
  },

  revertEdit: async (editId) => {
    try {
      await window.marudesk.invoke('agent:revert-edit', { editId });
    } catch {
      // ignore
    }
  },

  resetChat: async () => {
    try {
      await window.marudesk.invoke('agent:reset');
      set({ localError: null });
    } catch {
      // ignore
    }
  },
}));

/**
 * Open (or focus) the singleton full-surface AI Chat tab (v3 §5-B). The drawer
 * companion and this tab project the same single conversation, so this never
 * forks state — it just gives the chat a roomier home.
 */
export async function openAgentTab(): Promise<void> {
  const tabsState = useTabsStore.getState();
  const existing = tabsState.tabs.find((t) => t.kind === 'agent');
  if (existing) await tabsState.activateTab(existing.id);
  else await tabsState.newTab('agent');
}
