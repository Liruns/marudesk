import { createContext, createElement, useContext, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type {
  AgentAnswers,
  AgentChatState,
  AgentEditActionResult,
  AgentImageInput,
} from '../../../shared/agent';
import { emptyAgentChatState } from '../../../shared/agent';
import type { CapturePayload } from '../../../shared/composer';
import type { SessionSummary } from '../../../shared/context';
import {
  findModel,
  type ProviderId,
  type ProviderStatus,
} from '../../../shared/providers';
import type { CheckpointRestore } from '../../../shared/worktree';
import { SYSTEM_WORKSPACE_ID, type WorkspaceId } from '../../../shared/workspace';
import { toMessage } from '../../lib/toMessage';
import { useWebPageStore } from '../browser/store';
import { toPayload } from '../composer/store';
import { useGitStore } from '../git/store';
import { useProvidersStore } from '../providers/store';
import { useTabsStore } from '../tabs/store';
import { useWorkspaceDeckStore } from '../workspaces/store';
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

function normalizeAgentWorkspaceId(workspaceId: WorkspaceId | undefined): WorkspaceId | undefined {
  return workspaceId && workspaceId !== SYSTEM_WORKSPACE_ID ? workspaceId : undefined;
}

function scopedStorageKey(base: string, workspaceId: WorkspaceId | undefined): string {
  const scope = normalizeAgentWorkspaceId(workspaceId);
  return scope ? `${base}.${scope}` : base;
}

function loadHistory(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    // ignore — start with an empty history
  }
  return [];
}
function loadVerbosity(key: string): TranscriptVerbosity {
  try {
    const v = localStorage.getItem(key);
    if (v === 'summary' || v === 'normal' || v === 'verbose') return v;
  } catch {
    // ignore — fall back to the default
  }
  return 'normal';
}

type AgentState = {
  chat: AgentChatState;
  draft: string;
  draftByThread: Record<string, string>;
  /** Images pasted/dropped into the composer, sent with the next turn. */
  pendingImages: AgentImageInput[];
  pendingImagesByThread: Record<string, AgentImageInput[]>;
  /** Local files attached as @path context, sent with the next turn. */
  pendingFiles: PendingFileAttachment[];
  pendingFilesByThread: Record<string, PendingFileAttachment[]>;
  /** Transcript detail level for the message list. */
  verbosity: TranscriptVerbosity;
  /** Recently sent prompts (newest last) for up/down recall in the composer. */
  promptHistory: string[];
  /**
   * Prompts staged while a turn was running, sent one-at-a-time (FIFO) as each
   * turn finishes. A real queue — each Enter pushes a separate item rather than
   * concatenating into one blob — so the user can line up several follow-ups.
   */
  /** Active thread id in this workspace, mirrored from the ThreadBar summaries. */
  activeThreadId: string | null;
  /** Prompts staged for the ACTIVE thread while a turn is running. */
  queuedPrompts: string[];
  /** Per-thread queued prompts so one chat's follow-ups don't leak into another. */
  queuedPromptsByThread: Record<string, string[]>;
  /**
   * Per-thread model pin (model-catalog key). A thread pins its model on first
   * send (or an explicit pick in its composer) and keeps it even when another
   * chat selects something else; unpinned threads follow the global selection.
   */
  modelKeyByThread: Record<string, string>;
  /** Local pre-turn error (no key / no workspace / send rejected). */
  localError: string | null;
  localErrorByThread: Record<string, string | null>;
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
  /** Append a prompt to the send queue (staged while a turn is running). */
  enqueuePrompt: (text: string) => void;
  /** Pop the oldest queued prompt (FIFO) and return it, or null when empty. */
  dequeuePrompt: () => string | null;
  /** Remove one queued prompt by index (the banner's per-item delete). */
  removeQueuedPrompt: (index: number) => void;
  /** Switch composer-local queue state to the active thread from ThreadBar. */
  setActiveThreadId: (id: string | null) => void;
  /** Pin the ACTIVE thread to `key` and make it the global default for new threads. */
  setThreadModelKey: (key: string) => void;
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
  approveForTurn: (
    turnId: string,
    callId: string,
    approved: boolean,
    always?: boolean,
  ) => Promise<void>;
  acceptEdit: (editId: string) => Promise<AgentEditActionResult>;
  revertEdit: (editId: string) => Promise<AgentEditActionResult>;
  restoreTurnPage: (turnId: string) => Promise<void>;
  restoreCheckpoint: (turnId: string) => Promise<CheckpointRestore>;
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

type AgentStore = AgentState & AgentActions;
type AgentStoreApi = StoreApi<AgentStore>;

const AgentWorkspaceContext = createContext<WorkspaceId | undefined>(undefined);
const GLOBAL_AGENT_SCOPE = '__global__';
const agentStores = new Map<string, AgentStoreApi>();

function scopeKey(workspaceId: WorkspaceId | undefined): string {
  return normalizeAgentWorkspaceId(workspaceId) ?? GLOBAL_AGENT_SCOPE;
}

function scopedPayload(workspaceId: WorkspaceId | undefined): { workspaceId?: WorkspaceId } {
  const scope = normalizeAgentWorkspaceId(workspaceId);
  return scope ? { workspaceId: scope } : {};
}

function activeThreadKey(state: Pick<AgentState, 'activeThreadId'>): string {
  return state.activeThreadId ?? '__main__';
}

/** Whether `provider` has usable auth — an API key, keyless (Ollama), or OAuth. */
function hasAuthFor(status: ProviderStatus[], provider: ProviderId): boolean {
  const s = status.find((p) => p.id === provider);
  return !!s?.hasKey || !!s?.oauth;
}


function createAgentStore(workspaceId: WorkspaceId | undefined): AgentStoreApi {
  const scope = normalizeAgentWorkspaceId(workspaceId);
  const historyKey = scopedStorageKey(HISTORY_KEY, scope);
  const verbosityKey = scopedStorageKey(VERBOSITY_KEY, scope);

  return createStore<AgentStore>((set, get) => ({
  chat: emptyAgentChatState(),
  draft: '',
  draftByThread: {},
  pendingImages: [],
  pendingImagesByThread: {},
  pendingFiles: [],
  pendingFilesByThread: {},
  promptHistory: loadHistory(historyKey),
  activeThreadId: null,
  queuedPrompts: [],
  queuedPromptsByThread: {},
  modelKeyByThread: {},
  verbosity: loadVerbosity(verbosityKey),
  localError: null,
  localErrorByThread: {},
  sessions: [],

  setDraft: (draft) =>
    set((s) => {
      const threadId = activeThreadKey(s);
      return { draft, draftByThread: { ...s.draftByThread, [threadId]: draft } };
    }),

  addImages: (images) =>
    set((s) => {
      const threadId = activeThreadKey(s);
      const next = [...(s.pendingImagesByThread[threadId] ?? []), ...images].slice(0, 8);
      return { pendingImages: next, pendingImagesByThread: { ...s.pendingImagesByThread, [threadId]: next } };
    }),

  addFiles: (files) =>
    set((s) => {
      const threadId = activeThreadKey(s);
      const next = mergeFileAttachments(s.pendingFilesByThread[threadId] ?? [], files);
      return { pendingFiles: next, pendingFilesByThread: { ...s.pendingFilesByThread, [threadId]: next } };
    }),

  removeImage: (index) =>
    set((s) => {
      const threadId = activeThreadKey(s);
      const next = (s.pendingImagesByThread[threadId] ?? []).filter((_, i) => i !== index);
      return { pendingImages: next, pendingImagesByThread: { ...s.pendingImagesByThread, [threadId]: next } };
    }),

  removeFile: (index) =>
    set((s) => {
      const threadId = activeThreadKey(s);
      const next = (s.pendingFilesByThread[threadId] ?? []).filter((_, i) => i !== index);
      return { pendingFiles: next, pendingFilesByThread: { ...s.pendingFilesByThread, [threadId]: next } };
    }),

  enqueuePrompt: (text) => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    set((s) => {
      const threadId = s.activeThreadId ?? '__main__';
      const nextQueue = [...(s.queuedPromptsByThread[threadId] ?? []), trimmed];
      return {
        queuedPrompts: nextQueue,
        queuedPromptsByThread: { ...s.queuedPromptsByThread, [threadId]: nextQueue },
      };
    });
  },

  dequeuePrompt: () => {
    const threadId = get().activeThreadId ?? '__main__';
    const [next, ...rest] = get().queuedPromptsByThread[threadId] ?? [];
    if (next === undefined) return null;
    set((s) => ({
      queuedPrompts: rest,
      queuedPromptsByThread: { ...s.queuedPromptsByThread, [threadId]: rest },
    }));
    return next;
  },

  removeQueuedPrompt: (index) =>
    set((s) => {
      const threadId = s.activeThreadId ?? '__main__';
      const nextQueue = (s.queuedPromptsByThread[threadId] ?? []).filter((_, i) => i !== index);
      return {
        queuedPrompts: nextQueue,
        queuedPromptsByThread: { ...s.queuedPromptsByThread, [threadId]: nextQueue },
      };
    }),

  setActiveThreadId: (id) =>
    set((s) => {
      const threadId = id ?? '__main__';
      return {
        activeThreadId: id,
        draft: s.draftByThread[threadId] ?? '',
        pendingImages: s.pendingImagesByThread[threadId] ?? [],
        pendingFiles: s.pendingFilesByThread[threadId] ?? [],
        queuedPrompts: s.queuedPromptsByThread[threadId] ?? [],
        localError: s.localErrorByThread[threadId] ?? null,
      };
    }),

  setThreadModelKey: (key) => {
    // The pick also becomes the global default (new threads + next launch),
    // while every OTHER thread keeps its own pin — the per-thread isolation.
    useProvidersStore.getState().selectModel(key);
    set((s) => ({
      modelKeyByThread: { ...s.modelKeyByThread, [activeThreadKey(s)]: key },
    }));
  },

  setVerbosity: (verbosity) => {
    try {
      localStorage.setItem(verbosityKey, verbosity);
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
      const chat = await window.marudesk.invoke('agent:snapshot', scopedPayload(workspaceId));
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
      localStorage.setItem(historyKey, JSON.stringify(history));
    } catch {
      // ignore — in-memory history still updates
    }
    const fileContext = formatAttachedFilesForPrompt(pendingFiles);
    const prompt = fileContext ? `${text}\n\n${fileContext}` : text;
    const threadId = activeThreadKey(get());
    set((s) => ({
      localError: null,
      localErrorByThread: { ...s.localErrorByThread, [threadId]: null },
      draft: '',
      draftByThread: { ...s.draftByThread, [threadId]: '' },
      pendingImages: [],
      pendingImagesByThread: { ...s.pendingImagesByThread, [threadId]: [] },
      pendingFiles: [],
      pendingFilesByThread: { ...s.pendingFilesByThread, [threadId]: [] },
      promptHistory: history,
    }));
    const res = await get().dispatchPrompt(prompt, { images: pendingImages });
    // Restore the draft + attachments so the user can retry without re-attaching.
    if (!res.ok) {
      const reason = res.reason ?? null;
      set((s) => ({
        localError: reason,
        localErrorByThread: { ...s.localErrorByThread, [threadId]: reason },
        draft: text,
        draftByThread: { ...s.draftByThread, [threadId]: text },
        pendingImages,
        pendingImagesByThread: { ...s.pendingImagesByThread, [threadId]: pendingImages },
        pendingFiles,
        pendingFilesByThread: { ...s.pendingFilesByThread, [threadId]: pendingFiles },
      }));
    }
  },

  dispatchPrompt: async (prompt, opts) => {
    const providers = useProvidersStore.getState();
    // Per-thread model: a pinned thread keeps running on its own model; an
    // unpinned one resolves the global selection and pins it below, so a later
    // global change (another chat's pick) can't silently retarget this thread.
    const threadId = activeThreadKey(get());
    const pinnedKey = get().modelKeyByThread[threadId];
    const entry =
      (pinnedKey ? findModel(providers.models, pinnedKey) : undefined) ??
      findModel(providers.models, providers.selectedModelKey);
    const provider = entry?.provider ?? providers.selectedProvider;
    const model = entry?.id ?? providers.selectedModel;
    let hasKey = hasAuthFor(providers.providerStatus, provider);
    if (!hasKey && !providers.statusChecked) {
      await providers.refreshProviderStatus();
      hasKey = hasAuthFor(useProvidersStore.getState().providerStatus, provider);
    }
    // AI Chat no longer requires an open workspace — file tools just degrade to a
    // friendly "open a folder" message in main, while browser/page tools and a
    // plain conversation work without one.
    if (!hasKey) {
      return { ok: false, reason: `No API key configured for ${provider}. Add one in Settings.` };
    }
    if (!pinnedKey && entry) {
      set((s) => ({
        modelKeyByThread: { ...s.modelKeyByThread, [threadId]: entry.key },
      }));
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
        ...scopedPayload(scope),
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
    if (!res.ok && res.reason) {
      const threadId = activeThreadKey(get());
      set((s) => ({
        localError: res.reason!,
        localErrorByThread: { ...s.localErrorByThread, [threadId]: res.reason! },
      }));
    }
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
    await get().approveForTurn(turnId, callId, approved, always);
  },

  approveForTurn: async (turnId, callId, approved, always = false) => {
    try {
      await window.marudesk.invoke('agent:approve-tool', { turnId, callId, approved, always });
    } catch {
      // ignore
    }
  },

  acceptEdit: async (editId) => {
    try {
      return await window.marudesk.invoke('agent:accept-edit', {
        ...scopedPayload(workspaceId),
        editId,
      });
    } catch {
      return { ok: false };
    }
  },

  // Returns the result so the caller can surface a refused/failed revert (a
  // silent no-op is what the audit flagged — e.g. a stale-file refusal).
  revertEdit: async (editId) => {
    try {
      return await window.marudesk.invoke('agent:revert-edit', {
        ...scopedPayload(workspaceId),
        editId,
      });
    } catch {
      return { ok: false };
    }
  },

  // Runtime half of a turn-level rollback: re-navigate the web tab to where it
  // was when the turn started (no-op unless the agent moved the page). Paired
  // with Revert all in the changes card. Best-effort — never throws.
  restoreTurnPage: async (turnId) => {
    try {
      await window.marudesk.invoke('agent:restore-turn-page', { turnId });
    } catch {
      // best-effort
    }
  },

  // Roll the whole working tree back to a turn's start (§3.6). Safe: current work
  // is parked on the git stash stack first. Returns the result so the receipt can
  // surface a "no checkpoint" / apply-failure outcome.
  restoreCheckpoint: async (turnId) => {
    try {
      return await window.marudesk.invoke('agent:restore-checkpoint', { turnId });
    } catch {
      return { ok: false, reason: 'apply-failed' };
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
      await window.marudesk.invoke('agent:reset', scopedPayload(workspaceId));
      useDiffCommentsStore.getState().clearAll();
      const threadId = activeThreadKey(get());
      set((s) => ({
        localError: null,
        localErrorByThread: { ...s.localErrorByThread, [threadId]: null },
        draft: '',
        draftByThread: { ...s.draftByThread, [threadId]: '' },
        pendingImages: [],
        pendingImagesByThread: { ...s.pendingImagesByThread, [threadId]: [] },
        pendingFiles: [],
        pendingFilesByThread: { ...s.pendingFilesByThread, [threadId]: [] },
        queuedPrompts: [],
        queuedPromptsByThread: { ...s.queuedPromptsByThread, [threadId]: [] },
      }));
      // The conversation just cleared was persisted on its last finish() — refresh
      // the list so it shows up immediately in the history.
      await get().loadSessions();
    } catch {
      // ignore
    }
  },

  compact: async (focus?: string) => {
    try {
      return await window.marudesk.invoke('agent:compact', { ...scopedPayload(workspaceId), focus });
    } catch (err) {
      return { ok: false, reason: toMessage(err) };
    }
  },

  loadSessions: async () => {
    try {
      const sessions = await window.marudesk.invoke('agent:list-sessions', scopedPayload(workspaceId));
      set({ sessions });
    } catch {
      // best-effort; keep the prior list
    }
  },

  resumeSession: async (id) => {
    try {
      const ok = await window.marudesk.invoke('agent:resume-session', {
        ...scopedPayload(workspaceId),
        id,
      });
      if (ok) {
        useDiffCommentsStore.getState().clearAll();
        set({ localError: null });
        // Pin the thread to the session's last-used model so resuming an old
        // chat doesn't silently continue on whatever happens to be selected.
        const summary = get().sessions.find((s) => s.id === id);
        const entry = summary
          ? useProvidersStore
              .getState()
              .models.find((m) => m.provider === summary.provider && m.id === summary.model)
          : undefined;
        if (entry) {
          set((s) => ({
            modelKeyByThread: { ...s.modelKeyByThread, [activeThreadKey(s)]: entry.key },
          }));
        }
        await get().hydrate();
      }
    } catch {
      // ignore — the next agent:event reflects the real state
    }
  },

  deleteSession: async (id) => {
    try {
      await window.marudesk.invoke('agent:delete-session', { ...scopedPayload(workspaceId), id });
      await get().loadSessions();
    } catch {
      // ignore
    }
  },
  }));
}

export function getAgentStoreForWorkspace(workspaceId: WorkspaceId | undefined): AgentStoreApi {
  const scope = normalizeAgentWorkspaceId(workspaceId);
  const key = scopeKey(scope);
  const existing = agentStores.get(key);
  if (existing) return existing;
  const created = createAgentStore(scope);
  agentStores.set(key, created);
  return created;
}

export function AgentScopeProvider({
  workspaceId,
  children,
}: {
  workspaceId?: WorkspaceId;
  children?: ReactNode;
}) {
  return createElement(
    AgentWorkspaceContext.Provider,
    { value: normalizeAgentWorkspaceId(workspaceId) },
    children,
  );
}

export function useAgentWorkspaceId(): WorkspaceId | undefined {
  return useContext(AgentWorkspaceContext);
}

type AgentStoreHook = {
  <T>(selector: (state: AgentStore) => T): T;
  getState: AgentStoreApi['getState'];
  setState: AgentStoreApi['setState'];
  subscribe: AgentStoreApi['subscribe'];
};

const defaultAgentStore = getAgentStoreForWorkspace(undefined);

export const useAgentStore = Object.assign(
  <T,>(selector: (state: AgentStore) => T): T => {
    const workspaceId = useAgentWorkspaceId();
    return useStore(getAgentStoreForWorkspace(workspaceId), selector);
  },
  {
    getState: defaultAgentStore.getState,
    setState: defaultAgentStore.setState,
    subscribe: defaultAgentStore.subscribe,
  },
) as AgentStoreHook;

/**
 * Whether a turn is in flight — model thinking, tools running, or parked on an
 * approval/question. Shared selector so the composer, changes/recovery cards, and
 * capture cards agree on "busy" instead of each re-deriving the status set.
 */
/**
 * The ACTIVE thread's effective model key — its pin when set, else the global
 * selection. Drives the composer chip, the usage gauge, and the reasoning dial
 * so every per-thread surface agrees with what dispatchPrompt will actually run.
 */
export const useThreadModelKey = (): string => {
  const pinned = useAgentStore((s) => s.modelKeyByThread[activeThreadKey(s)] ?? null);
  const globalKey = useProvidersStore((s) => s.selectedModelKey);
  return pinned ?? globalKey;
};

export const useAgentBusy = (): boolean =>
  useAgentStore(
    (s) =>
      s.chat.status === 'thinking' ||
      s.chat.status === 'working' ||
      s.chat.status === 'waiting_for_user',
  );

function resolveAgentWorkspaceId(workspaceId?: WorkspaceId): WorkspaceId | undefined {
  const requested = normalizeAgentWorkspaceId(workspaceId);
  if (requested) return requested;
  const tabsState = useTabsStore.getState();
  const activeTab = tabsState.tabs.find((t) => t.id === tabsState.activeTabId);
  return normalizeAgentWorkspaceId(
    activeTab?.workspaceId ?? useWorkspaceDeckStore.getState().activeWorkspaceId ?? undefined,
  );
}

/** Open a new full-surface AI Chat tab (always creates a fresh tab). */
export async function openAgentTab(workspaceId?: WorkspaceId): Promise<void> {
  const targetWorkspaceId = resolveAgentWorkspaceId(workspaceId);
  await useTabsStore.getState().newTab('agent', undefined, targetWorkspaceId);
}

/**
 * Open a new "AI Chat (CLI)" terminal tab (always creates a fresh tab). An
 * always-available sibling of the chat drawer/panel — reachable from the Home
 * launcher and the `marudesk` terminal command, not gated by a setting.
 */
export async function openCliChatTab(workspaceId?: WorkspaceId): Promise<void> {
  const targetWorkspaceId = resolveAgentWorkspaceId(workspaceId);
  await useTabsStore.getState().newTab('terminal', undefined, targetWorkspaceId, { terminalProfile: 'agent-cli' });
}

/**
 * Focus an existing AI Chat tab for the workspace, or create one if none exists.
 * Used by surfaces that need to send a prompt to the workspace's chat session
 * (e.g. "Fix this", specs, captures) — avoids tab clutter while keeping the
 * shared per-workspace agent store reachable.
 */
export async function focusOrOpenAgentTab(workspaceId?: WorkspaceId): Promise<void> {
  const targetWorkspaceId = resolveAgentWorkspaceId(workspaceId);
  const tabsState = useTabsStore.getState();
  const existing = tabsState.tabs.find(
    (t) =>
      t.kind === 'agent' && normalizeAgentWorkspaceId(t.workspaceId) === targetWorkspaceId,
  );
  if (existing) await tabsState.activateTab(existing.id);
  else await tabsState.newTab('agent', undefined, targetWorkspaceId);
}

/**
 * Focus or open the AI Chat, prefill a prompt, and send it in one shot. Lets
 * surfaces outside the composer (e.g. the DevTools console "Fix this" button)
 * hand a ready-made request to the agent with a single click. Any captures that
 * were already staged + selected in {@link useWebPageStore} ride along via
 * `send()`. If a turn is already running, `send()` no-ops and the prefilled
 * prompt simply waits in the composer.
 */
export async function askAgent(prompt: string): Promise<void> {
  const workspaceId = resolveAgentWorkspaceId();
  await focusOrOpenAgentTab(workspaceId);
  const store = getAgentStoreForWorkspace(workspaceId).getState();
  store.setDraft(prompt);
  await store.send();
}
