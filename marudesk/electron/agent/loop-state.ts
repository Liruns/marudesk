import type { ModelMessage } from 'ai';
import { coalesced } from '../coalesce';
import { getHost } from '../browser/state';
import { getSettingsSync } from '../settings';
import {
  emptyAgentChatState,
  type AgentAnswers,
  type AgentChatState,
  type ThreadSummary,
} from '../../shared/agent';

/** Approval decision from the UI: approved/denied, plus "always for this session". */
export type ApprovalDecision = { approved: boolean; always: boolean };

/**
 * One conversation thread's authoritative mutable state (docs/agentic-chat-design
 * §5). Historically there was a single global container; Stage 12-B-2 promotes it
 * to a registry of threads so the user can hold several conversations at once and
 * switch between them. {@link S} is a live binding pointing at the ACTIVE thread's
 * container — reassigned only by {@link switchThread}, and only while idle, so a
 * running turn (which mutates `S` by reference) never has the container swapped
 * out from under it. Every module that did `S.state = …` keeps working unchanged.
 */
export type ThreadContainer = {
  state: AgentChatState;
  // The provider-neutral running transcript (multi-turn). Kept valid at all times
  // (every tool_use is answered by a tool_result) so a later turn can reuse it.
  transcript: ModelMessage[];
  controller: AbortController | null;
  approvalResolver: ((decision: ApprovalDecision) => void) | null;
  // Gated tools the user chose to "Allow always" for this conversation; cleared
  // on reset/resume so it never leaks across conversations.
  sessionAllowedTools: Set<string>;
  // Active sticky keyword modes (ultrawork/search/analyze/think) for this
  // conversation; cleared on reset/resume. See keyword-modes.ts.
  activeModes: string[];
  answersResolver: ((answers: AgentAnswers) => void) | null;
  // Synchronous re-entrancy guard: status is only set busy after an await in
  // startTurn, so this closes the window before the first await.
  starting: boolean;
  // The web tab the active turn targets — so finish() can stop the lazy network
  // capture it may have enabled.
  activeTabId: string | undefined;
  // The current conversation's stable session id + metadata, reused across the
  // conversation's turns; reset() clears it so the next turn begins a new session.
  conversationId: string | null;
  conversationStartedAt: number;
  conversationProvider: string;
  conversationModel: string;
  conversationTitle: string;
};

function makeThreadContainer(): ThreadContainer {
  return {
    state: emptyAgentChatState(),
    transcript: [],
    controller: null,
    approvalResolver: null,
    sessionAllowedTools: new Set<string>(),
    activeModes: [],
    answersResolver: null,
    starting: false,
    activeTabId: undefined,
    conversationId: null,
    conversationStartedAt: 0,
    conversationProvider: '',
    conversationModel: '',
    conversationTitle: '',
  };
}

/** Stable id of the default foreground thread — always present, never closeable last. */
export const MAIN_THREAD = 'main';

/** The live thread registry (foreground conversations the user can switch between). */
const threads = new Map<string, ThreadContainer>();
let activeId: string = MAIN_THREAD;

/** The ACTIVE thread's container. A live binding — see {@link switchThread}. */
export let S: ThreadContainer = makeThreadContainer();
threads.set(MAIN_THREAD, S);

// Monotonic id counter, module-global so ids stay unique across threads.
let seq = 0;
export function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${++seq}`;
}

/**
 * The active conversation (thread) id, or null when no chat has started. Used to
 * scope worktree isolation per thread (Stage 12-B-2) without coupling the
 * isolation module to the loop's S container.
 */
export function activeConversationId(): string | null {
  return S.conversationId;
}

function isBusy(c: ThreadContainer): boolean {
  return (
    c.state.status === 'thinking' ||
    c.state.status === 'working' ||
    c.state.status === 'waiting_for_user'
  );
}

export function busy(): boolean {
  return isBusy(S);
}

/* ── thread registry (Stage 12-B-2) ──────────────────────────────────────── */

/** The active thread's id. */
export function activeThreadId(): string {
  return activeId;
}

/** Every open thread (active first is NOT guaranteed — the UI sorts/marks active). */
export function listThreads(): ThreadSummary[] {
  return [...threads.entries()].map(([id, c]) => ({
    id,
    title: c.conversationTitle || 'New chat',
    status: c.state.status,
    active: id === activeId,
    busy: isBusy(c),
    messageCount: c.state.messages.length,
  }));
}

/** Create a new, empty foreground thread and return its id (does NOT switch to it). */
export function newThread(): string {
  const id = uid('thread');
  threads.set(id, makeThreadContainer());
  emitThreads();
  return id;
}

/**
 * Switch the active thread. Refuses while the CURRENT thread is mid-turn — the
 * running loop mutates `S` by reference, so swapping the container then would
 * corrupt it. (Only one thread executes at a time; concurrent foreground
 * execution is a later step.) Returns false if the id is unknown or busy.
 */
export function switchThread(id: string): boolean {
  if (id === activeId) return true;
  const target = threads.get(id);
  if (!target) return false;
  if (busy()) return false;
  activeId = id;
  S = target;
  emit();
  emitThreads();
  return true;
}

/**
 * Close a thread. Refuses to close the last one. Aborts its turn if running, and
 * switches to another thread when closing the active one.
 */
export function closeThread(id: string): boolean {
  if (threads.size <= 1 || !threads.has(id)) return false;
  const c = threads.get(id)!;
  if (isBusy(c)) c.controller?.abort();
  threads.delete(id);
  if (id === activeId) {
    const next = [...threads.keys()][0];
    activeId = next;
    S = threads.get(next)!;
    emit();
  }
  emitThreads();
  return true;
}

/** Test-only reset of the registry to a single empty main thread. */
export function __resetThreadsForTests(): void {
  threads.clear();
  seq = 0;
  activeId = MAIN_THREAD;
  S = makeThreadContainer();
  threads.set(MAIN_THREAD, S);
}

/* ── event fan-out (renderer push + in-process subscribers) ─────────────── */

// In-process subscribers to the authoritative state stream. The headless server
// (electron/server) subscribes here to relay `agent:event` over SSE — the loop's
// functions are called directly (no IPC), so this is the renderer-side push's
// peer for any non-renderer head. Kept module-level so it survives across turns.
const subscribers = new Set<(state: AgentChatState) => void>();

/**
 * Subscribe to the authoritative {@link AgentChatState} stream — every state the
 * renderer would receive on `agent:event` is also delivered here. Used by the
 * in-process bridge server (docs/remote-mobile-bridge-design §M4). Returns an
 * unsubscribe fn. Callbacks are isolated so one bad subscriber can't break the
 * others or the renderer push.
 */
export function subscribeAgentEvents(cb: (state: AgentChatState) => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

export const emit = coalesced(() => {
  // Stamp the live approval mode (a setting, not loop state) into the projection
  // so thin clients reflect it (U10). Cheap in-memory read; the desktop ignores
  // this field and reads its settings store directly.
  S.state.approvalMode = getSettingsSync().agent.approvalMode;
  const host = getHost();
  if (host && !host.isDestroyed()) {
    host.webContents.send('agent:event', S.state);
    // Keep the thread switcher live as status/title change during a turn.
    host.webContents.send('agent:threads', listThreads());
  }
  for (const cb of subscribers) {
    try {
      cb(S.state);
    } catch {
      // A subscriber must never break the loop's fan-out.
    }
  }
});

/** Push just the thread list (structure changed: new/switch/close), not the state. */
export function emitThreads(): void {
  const host = getHost();
  if (host && !host.isDestroyed()) host.webContents.send('agent:threads', listThreads());
}
