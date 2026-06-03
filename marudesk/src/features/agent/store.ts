import { create } from 'zustand';
import type { AgentAnswers, AgentChatState, AgentImageInput } from '../../../shared/agent';
import { emptyAgentChatState } from '../../../shared/agent';
import type { SessionSummary } from '../../../shared/context';
import { toMessage } from '../../lib/toMessage';
import { useWebPageStore } from '../browser/store';
import { toPayload } from '../composer/store';
import { useGitStore } from '../git/store';
import { useProvidersStore } from '../providers/store';
import { useTabsStore } from '../tabs/store';

/**
 * Renderer projection of the agentic AI Chat (docs/agentic-chat-design.md §8).
 * main owns the authoritative state; this store mirrors the latest `agent:event`
 * snapshot and exposes thin action wrappers over the `agent:*` invokes. Provider/
 * model/key selection is reused from the composer store — the agent shares the
 * same configured providers rather than duplicating that machinery.
 */

/**
 * Transcript density (Claude Desktop's Summary / Normal / Verbose dial). A local
 * display preference persisted to localStorage — deliberately NOT part of the
 * server-owned {@link AgentChatState}, since it only affects this renderer's view.
 */
export type TranscriptVerbosity = 'summary' | 'normal' | 'verbose';

const VERBOSITY_KEY = 'marudesk.agent.verbosity';
const HISTORY_KEY = 'marudesk.agent.promptHistory';
const HISTORY_CAP = 100;

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    // ignore — start with an empty history
  }
  return [];
}
function loadVerbosity(): TranscriptVerbosity {
  try {
    const v = localStorage.getItem(VERBOSITY_KEY);
    if (v === 'summary' || v === 'normal' || v === 'verbose') return v;
  } catch {
    // ignore — fall back to the default
  }
  return 'normal';
}

type AgentState = {
  chat: AgentChatState;
  draft: string;
  /** Images pasted/dropped into the composer, sent with the next turn. */
  pendingImages: AgentImageInput[];
  /** Transcript detail level for the message list. */
  verbosity: TranscriptVerbosity;
  /** Recently sent prompts (newest last) for up/down recall in the composer. */
  promptHistory: string[];
  /** A prompt typed while a turn was running, auto-sent when the turn finishes. */
  queuedPrompt: string | null;
  /** Local pre-turn error (no key / no workspace / send rejected). */
  localError: string | null;
  /** Saved sessions (newest first) for the history list — loaded on demand. */
  sessions: SessionSummary[];
};

type AgentActions = {
  setDraft: (v: string) => void;
  /** Append pasted/dropped images to the pending attachment strip. */
  addImages: (images: AgentImageInput[]) => void;
  /** Remove one pending image by index. */
  removeImage: (index: number) => void;
  /** Set (or clear) the prompt queued to auto-send when the current turn ends. */
  setQueuedPrompt: (v: string | null) => void;
  setVerbosity: (v: TranscriptVerbosity) => void;
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
  /** Refresh the saved-session list from main. */
  loadSessions: () => Promise<void>;
  /** Load a saved session as the active conversation, then re-hydrate the chat. */
  resumeSession: (id: string) => Promise<void>;
  /** Delete a saved session and refresh the list. */
  deleteSession: (id: string) => Promise<void>;
};

function activeWebTabId(): string | undefined {
  const { activeTabId, tabs } = useTabsStore.getState();
  const active = tabs.find((t) => t.id === activeTabId);
  return active?.kind === 'web' ? active.id : undefined;
}

/**
 * Trigger a Source Control refresh when the agent's applied-edits set actually
 * changes (a new edit, or an accept/revert flipping a status) — not on every
 * streaming snapshot. The signature is the appended edits' `id:status`; an empty
 * set (fresh chat / reset) is skipped since it implies no new disk change.
 */
let prevEditsSig = '';
function maybeRefreshGitForEdits(chat: AgentChatState): void {
  const sig = chat.edits.map((e) => `${e.id}:${e.status}`).join('|');
  if (sig === prevEditsSig) return;
  prevEditsSig = sig;
  if (chat.edits.length === 0) return;
  void useGitStore.getState().refresh();
}

export const useAgentStore = create<AgentState & AgentActions>((set, get) => ({
  chat: emptyAgentChatState(),
  draft: '',
  pendingImages: [],
  promptHistory: loadHistory(),
  queuedPrompt: null,
  verbosity: loadVerbosity(),
  localError: null,
  sessions: [],

  setDraft: (draft) => set({ draft }),

  addImages: (images) =>
    set((s) => ({ pendingImages: [...s.pendingImages, ...images].slice(0, 8) })),

  removeImage: (index) =>
    set((s) => ({ pendingImages: s.pendingImages.filter((_, i) => i !== index) })),

  setQueuedPrompt: (queuedPrompt) => set({ queuedPrompt }),

  setVerbosity: (verbosity) => {
    try {
      localStorage.setItem(VERBOSITY_KEY, verbosity);
    } catch {
      // ignore — the in-memory value still updates
    }
    set({ verbosity });
  },

  ingest: (chat) => {
    set({ chat });
    // When the agent writes (or accepts/reverts) a file edit, those changes land
    // on disk — keep Source Control in step without a manual refresh. Keyed off the
    // edits' id:status signature so the frequent streaming snapshots don't refire
    // git: only an actual edit landing/changing does. (refresh() is a no-op when
    // there's no repo, so this is safe regardless of workspace state.)
    maybeRefreshGitForEdits(chat);
    // A turn that just ended persisted its (possibly brand-new) session — refresh
    // the history list so it appears immediately, not only on the next New chat.
    if ((chat.status === 'completed' || chat.status === 'failed') && chat.activeSessionId) {
      void get().loadSessions();
    }
  },

  hydrate: async () => {
    try {
      const chat = await window.marudesk.invoke('agent:snapshot');
      set({ chat });
    } catch {
      // best-effort; the next agent:event will populate it
    }
  },

  send: async () => {
    const { draft, chat, pendingImages } = get();
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

    // Record the prompt for up/down recall (dedupe consecutive repeats, cap len).
    const history = [...get().promptHistory.filter((h) => h !== text), text].slice(-HISTORY_CAP);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch {
      // ignore — in-memory history still updates
    }
    set({ localError: null, draft: '', pendingImages: [], promptHistory: history });
    try {
      const res = await window.marudesk.invoke('agent:send', {
        provider,
        model,
        prompt: text,
        captures,
        images: pendingImages.length > 0 ? pendingImages : undefined,
        tabId: activeWebTabId(),
      });
      // Restore the draft + images so the user can retry without re-attaching.
      if (!res.ok) set({ localError: res.reason, draft: text, pendingImages });
    } catch (err) {
      set({ localError: toMessage(err), draft: text, pendingImages });
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
      // The conversation just cleared was persisted on its last finish() — refresh
      // the list so it shows up immediately in the history.
      await get().loadSessions();
    } catch {
      // ignore
    }
  },

  loadSessions: async () => {
    try {
      const sessions = await window.marudesk.invoke('agent:list-sessions');
      set({ sessions });
    } catch {
      // best-effort; keep the prior list
    }
  },

  resumeSession: async (id) => {
    try {
      const ok = await window.marudesk.invoke('agent:resume-session', { id });
      if (ok) {
        set({ localError: null });
        await get().hydrate();
      }
    } catch {
      // ignore — the next agent:event reflects the real state
    }
  },

  deleteSession: async (id) => {
    try {
      await window.marudesk.invoke('agent:delete-session', { id });
      await get().loadSessions();
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

/**
 * Open (or focus) the AI Chat, prefill a prompt, and send it in one shot. Lets
 * surfaces outside the composer (e.g. the DevTools console "Fix this" button)
 * hand a ready-made request to the agent with a single click. Any captures that
 * were already staged + selected in {@link useWebPageStore} ride along via
 * `send()`. If a turn is already running, `send()` no-ops and the prefilled
 * prompt simply waits in the composer.
 */
export async function askAgent(prompt: string): Promise<void> {
  await openAgentTab();
  const store = useAgentStore.getState();
  store.setDraft(prompt);
  await store.send();
}
