import { create } from 'zustand';
import type {
  AgentAnswers,
  AgentChatState,
  AgentEditActionResult,
  AgentImageInput,
} from '../../../shared/agent';
import { emptyAgentChatState } from '../../../shared/agent';
import type { CapturePayload } from '../../../shared/composer';
import type { SessionSummary } from '../../../shared/context';
import { toMessage } from '../../lib/toMessage';
import { useWebPageStore } from '../browser/store';
import { toPayload } from '../composer/store';
import { useGitStore } from '../git/store';
import { useProvidersStore } from '../providers/store';
import { useTabsStore } from '../tabs/store';
import {
  formatAttachedFilesForPrompt,
  mergeFileAttachments,
  type PendingFileAttachment,
} from './chat/attachments';
import { useDiffCommentsStore } from './chat/diffComments';

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
  /** Local files attached as @path context, sent with the next turn. */
  pendingFiles: PendingFileAttachment[];
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
  /** Append local file references to the pending attachment strip. */
  addFiles: (files: PendingFileAttachment[]) => void;
  /** Remove one pending image by index. */
  removeImage: (index: number) => void;
  /** Remove one pending file by index. */
  removeFile: (index: number) => void;
  /** Set (or clear) the prompt queued to auto-send when the current turn ends. */
  setQueuedPrompt: (v: string | null) => void;
  setVerbosity: (v: TranscriptVerbosity) => void;
  /** Replace the projection from an `agent:event` snapshot. */
  ingest: (chat: AgentChatState) => void;
  /** Pull the current state on mount (catches up after the panel was unmounted). */
  hydrate: () => Promise<void>;
  send: () => Promise<void>;
  /**
   * Resolve the selected provider/model/key, attach context (the selected captures
   * by default, or an explicit `captures` override) + active web tab, and fire one
   * `agent:send`. Shared by {@link send} and feedback flows (diff inline comments
   * §U1, element comments §U2) so they don't duplicate the wiring. Does not touch
   * the composer draft/history — callers own that.
   */
  dispatchPrompt: (
    prompt: string,
    opts?: { images?: AgentImageInput[]; captures?: CapturePayload[] },
  ) => Promise<{ ok: boolean; reason?: string }>;
  /**
   * Send a ready-made prompt as a turn (diff-comment / element-comment feedback).
   * Pass `captures` to attach a specific capture instead of the selected cart.
   * No-ops with a `busy` reason while a turn is in flight; surfaces a hard failure
   * as localError.
   */
  submitPrompt: (
    prompt: string,
    opts?: { captures?: CapturePayload[] },
  ) => Promise<{ ok: boolean; reason?: string }>;
  abort: () => Promise<void>;
  answer: (callId: string, answers: AgentAnswers) => Promise<void>;
  approve: (callId: string, approved: boolean, always?: boolean) => Promise<void>;
  acceptEdit: (editId: string) => Promise<AgentEditActionResult>;
  revertEdit: (editId: string) => Promise<AgentEditActionResult>;
  cancelBackground: (id: string) => Promise<void>;
  /** Steerable plan (v6 §U5): toggle a step's status or remove it. */
  editPlanStep: (id: string, op: { status?: string; remove?: boolean }) => Promise<void>;
  resetChat: () => Promise<void>;
  /**
   * Summarize the transcript for the model to free context while keeping the
   * visible scrollback (claude-code `/compact`). `focus` (from `/compact <focus>`)
   * tells the summarizer what to preserve in extra detail.
   */
  compact: (focus?: string) => Promise<{ ok: boolean; reason?: string }>;
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
  pendingFiles: [],
  promptHistory: loadHistory(),
  queuedPrompt: null,
  verbosity: loadVerbosity(),
  localError: null,
  sessions: [],

  setDraft: (draft) => set({ draft }),

  addImages: (images) =>
    set((s) => ({ pendingImages: [...s.pendingImages, ...images].slice(0, 8) })),

  addFiles: (files) =>
    set((s) => ({ pendingFiles: mergeFileAttachments(s.pendingFiles, files) })),

  removeImage: (index) =>
    set((s) => ({ pendingImages: s.pendingImages.filter((_, i) => i !== index) })),

  removeFile: (index) =>
    set((s) => ({ pendingFiles: s.pendingFiles.filter((_, i) => i !== index) })),

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
    const { draft, chat, pendingImages, pendingFiles } = get();
    const text = draft.trim();
    if (text.length === 0) return;
    if (chat.status === 'thinking' || chat.status === 'working' || chat.status === 'waiting_for_user') {
      return;
    }

    // Record the prompt for up/down recall (dedupe consecutive repeats, cap len).
    const history = [...get().promptHistory.filter((h) => h !== text), text].slice(-HISTORY_CAP);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch {
      // ignore — in-memory history still updates
    }
    const fileContext = formatAttachedFilesForPrompt(pendingFiles);
    const prompt = fileContext ? `${text}\n\n${fileContext}` : text;
    set({ localError: null, draft: '', pendingImages: [], pendingFiles: [], promptHistory: history });
    const res = await get().dispatchPrompt(prompt, { images: pendingImages });
    // Restore the draft + images so the user can retry without re-attaching.
    if (!res.ok) set({ localError: res.reason ?? null, draft: text, pendingImages, pendingFiles });
  },

  dispatchPrompt: async (prompt, opts) => {
    const providers = useProvidersStore.getState();
    const provider = providers.selectedProvider;
    const model = providers.selectedModel;
    let hasKey = providers.hasKeyForSelected();
    if (!hasKey && !providers.statusChecked) {
      await providers.refreshProviderStatus();
      hasKey = useProvidersStore.getState().hasKeyForSelected();
    }
    // AI Chat no longer requires an open workspace — file tools just degrade to a
    // friendly "open a folder" message in main, while browser/page tools and a
    // plain conversation work without one.
    if (!hasKey) {
      return { ok: false, reason: `No API key configured for ${provider}. Add one in Settings.` };
    }

    const web = useWebPageStore.getState();
    const captures =
      opts?.captures ??
      web.captures.filter((c) => web.selectedCaptureIds.has(c.id)).map(toPayload);
    const images = opts?.images;
    try {
      const res = await window.marudesk.invoke('agent:send', {
        provider,
        model,
        prompt,
        captures,
        images: images && images.length > 0 ? images : undefined,
        tabId: activeWebTabId(),
      });
      return res.ok ? { ok: true } : { ok: false, reason: res.reason };
    } catch (err) {
      return { ok: false, reason: toMessage(err) };
    }
  },

  submitPrompt: async (prompt, opts) => {
    const { status } = get().chat;
    if (status === 'thinking' || status === 'working' || status === 'waiting_for_user') {
      return { ok: false, reason: 'busy' };
    }
    const res = await get().dispatchPrompt(prompt, { captures: opts?.captures });
    if (!res.ok && res.reason) set({ localError: res.reason });
    return res;
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

  approve: async (callId, approved, always = false) => {
    const turnId = get().chat.turnId;
    if (!turnId) return;
    try {
      await window.marudesk.invoke('agent:approve-tool', { turnId, callId, approved, always });
    } catch {
      // ignore
    }
  },

  acceptEdit: async (editId) => {
    try {
      return await window.marudesk.invoke('agent:accept-edit', { editId });
    } catch {
      return { ok: false };
    }
  },

  // Returns the result so the caller can surface a refused/failed revert (a
  // silent no-op is what the audit flagged — e.g. a stale-file refusal).
  revertEdit: async (editId) => {
    try {
      return await window.marudesk.invoke('agent:revert-edit', { editId });
    } catch {
      return { ok: false };
    }
  },

  cancelBackground: async (id) => {
    try {
      await window.marudesk.invoke('agent:cancel-background', { id });
    } catch {
      // ignore — the next snapshot reflects the real state
    }
  },

  editPlanStep: async (id, op) => {
    try {
      await window.marudesk.invoke('agent:edit-plan-step', { id, ...op });
    } catch {
      // ignore — the next agent:event snapshot reflects the real plan state
    }
  },

  resetChat: async () => {
    try {
      await window.marudesk.invoke('agent:reset');
      useDiffCommentsStore.getState().clearAll();
      set({ localError: null });
      // The conversation just cleared was persisted on its last finish() — refresh
      // the list so it shows up immediately in the history.
      await get().loadSessions();
    } catch {
      // ignore
    }
  },

  compact: async (focus?: string) => {
    try {
      return await window.marudesk.invoke('agent:compact', focus);
    } catch (err) {
      return { ok: false, reason: toMessage(err) };
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
        useDiffCommentsStore.getState().clearAll();
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
