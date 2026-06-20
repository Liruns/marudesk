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
import type { WorkspaceId } from '../../shared/workspace';
import { deriveRuntimeSnapshot, refreshOrchestrationState } from './orchestration-state.ts';
import type { OrchestrationThreadEntry } from './orchestration-state.ts';
import type { RuntimeSnapshot } from '../../shared/agent-orchestration';

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
  workspaceId: WorkspaceId | null;
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
  // Epoch ms of the last successful compaction (manual, auto, or preemptive).
  // Drives the preemptive mid-turn cooldown so a long multi-tool turn can't
  // thrash the compactor, and the post-compaction degradation monitor.
  lastCompactionAt: number;
  // Consecutive empty / tool-only assistant responses observed SINCE the last
  // compaction (degradation signal — a too-lossy summary leaves the model
  // spinning). Reset to 0 by any response carrying visible text, and on
  // compaction. See the post-compaction degradation monitor in loop.ts.
  postCompactionEmptyStreak: number;
  // Assistant responses still left in the post-compaction degradation MONITOR
  // window. Set to a fixed count by a compaction and decremented per response;
  // the monitor is inert once it reaches 0 so normal long tool-only stretches in
  // a healthy session never trip it. See the degradation monitor in loop.ts.
  postCompactionMonitorRemaining: number;
};

function makeThreadContainer(workspaceId: WorkspaceId | null = null): ThreadContainer {
  return {
    workspaceId,
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
    lastCompactionAt: 0,
    postCompactionEmptyStreak: 0,
    postCompactionMonitorRemaining: 0,
  };
}

/** Stable id of the default foreground thread — always present, never closeable last. */
export const MAIN_THREAD = 'main';

/** The live thread registry (foreground conversations the user can switch between). */
const threads = new Map<string, ThreadContainer>();
const activeThreadIdsByWorkspace = new Map<WorkspaceId, string>();
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

/* ── concurrent-turn plumbing (Stage 12-B-2) ──────────────────────────────── */

/** The current ACTIVE thread container (what a fresh turn binds to). */
export function currentContainer(): ThreadContainer {
  return S;
}

/** Every open thread container — for routing a turn-control action by turnId. */
export function containers(): ThreadContainer[] {
  return [...threads.values()];
}

/** The container for a specific thread id, or null if it's gone (canvas: each
 *  AI Chat card binds to its own thread and runs/streams independently). */
export function containerForThread(id: string): ThreadContainer | null {
  return threads.get(id) ?? null;
}

export function refreshOrchestrationProjection(): void {
  refreshOrchestrationState(threadProjectionEntries());
}

/**
 * A typed, serializable snapshot of all live agent work — every thread plus its
 * background agents (SECOND-PASS "Typed runtime snapshot"). Optionally scoped to
 * one workspace (omit for every thread, e.g. a bug-report dump). Pure read of the
 * in-memory registry via the same projection the orchestration tree uses.
 */
export function runtimeSnapshot(workspaceId?: WorkspaceId): RuntimeSnapshot {
  const entries = threadProjectionEntries().filter((entry) =>
    workspaceId ? entry.container.workspaceId === workspaceId : true,
  );
  return deriveRuntimeSnapshot(entries);
}

function activeThreadIdForWorkspace(workspaceId: WorkspaceId): string | null {
  const active = activeThreadIdsByWorkspace.get(workspaceId);
  if (active && threads.get(active)?.workspaceId === workspaceId) return active;
  const first = [...threads.entries()].find(([, c]) => c.workspaceId === workspaceId)?.[0] ?? null;
  if (first) activeThreadIdsByWorkspace.set(workspaceId, first);
  return first;
}

function workspaceThreadIds(): WorkspaceId[] {
  return [
    ...new Set(
      [...threads.values()]
        .map((container) => container.workspaceId)
        .filter((workspaceId): workspaceId is WorkspaceId => workspaceId !== null),
    ),
  ];
}

export function containerForWorkspace(workspaceId: WorkspaceId | undefined): ThreadContainer {
  if (!workspaceId) return S;
  const active = activeThreadIdForWorkspace(workspaceId);
  if (active) return threads.get(active)!;
  const id = uid('thread');
  const container = makeThreadContainer(workspaceId);
  threads.set(id, container);
  activeThreadIdsByWorkspace.set(workspaceId, id);
  emitThreads();
  return container;
}

/** Whether a specific container has a turn in flight. */
export function containerBusy(c: ThreadContainer): boolean {
  return isBusy(c);
}

/**
 * Find the container that owns a given turn, by its live turnId. A turn runs on a
 * captured container even after the user switches threads, so turn-control
 * actions (approve/respond/abort) must route by turnId across ALL threads, not
 * the global active one.
 */
export function containerForTurn(turnId: string): ThreadContainer | null {
  for (const c of threads.values()) {
    if (c.state.turnId === turnId) return c;
  }
  return null;
}

/* ── thread registry (Stage 12-B-2) ──────────────────────────────────────── */

/** The active thread's id. */
export function activeThreadId(): string {
  return activeId;
}

/** Every open thread (active first is NOT guaranteed — the UI sorts/marks active). */
export function listThreads(workspaceId?: WorkspaceId): ThreadSummary[] {
  const activeWorkspaceThreadId = workspaceId ? activeThreadIdForWorkspace(workspaceId) : null;
  return [...threads.entries()]
    .filter(([, c]) => (workspaceId ? c.workspaceId === workspaceId : c.workspaceId === null))
    .map(([id, c]) => ({
    id,
    ...(c.workspaceId ? { workspaceId: c.workspaceId } : {}),
    title: c.conversationTitle || 'New chat',
    status: c.state.status,
    active: workspaceId ? id === activeWorkspaceThreadId : id === activeId,
    busy: isBusy(c),
    messageCount: c.state.messages.length,
  }));
}

/** Create a new, empty foreground thread and return its id (does NOT switch to it). */
export function newThread(workspaceId?: WorkspaceId): string {
  const id = uid('thread');
  threads.set(id, makeThreadContainer(workspaceId ?? null));
  emitThreads();
  return id;
}

/**
 * Switch the active thread. Now that turns are bound to a captured container
 * (Stage 12-B-2 concurrent execution), switching is safe even while another
 * thread runs — the running turn keeps mutating its own container. Returns false
 * only if the id is unknown.
 */
export function switchThread(id: string, workspaceId?: WorkspaceId): boolean {
  const target = threads.get(id);
  if (!target) return false;
  if (workspaceId) {
    if (target.workspaceId !== workspaceId) return false;
    activeThreadIdsByWorkspace.set(workspaceId, id);
    emitContainer(target);
    emitThreads();
    return true;
  }
  if (target.workspaceId !== null) return false;
  if (id === activeId) return true;
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
export function closeThread(id: string, workspaceId?: WorkspaceId): boolean {
  const scopedThreads = workspaceId
    ? [...threads.entries()].filter(([, c]) => c.workspaceId === workspaceId)
    : [...threads.entries()].filter(([, c]) => c.workspaceId === null);
  if (scopedThreads.length <= 1 || !threads.has(id)) return false;
  const c = threads.get(id)!;
  if (workspaceId && c.workspaceId !== workspaceId) return false;
  if (!workspaceId && c.workspaceId !== null) return false;
  if (isBusy(c)) c.controller?.abort();
  threads.delete(id);
  let stateEmitted = false;
  if (workspaceId) {
    if (activeThreadIdsByWorkspace.get(workspaceId) === id) {
      const next = scopedThreads.find(([threadId]) => threadId !== id)?.[0] ?? null;
      if (next) activeThreadIdsByWorkspace.set(workspaceId, next);
      else activeThreadIdsByWorkspace.delete(workspaceId);
      const nextContainer = next ? threads.get(next) : null;
      if (nextContainer) {
        emitContainer(nextContainer);
        stateEmitted = true;
      }
    } else {
      const active = activeThreadIdForWorkspace(workspaceId);
      const activeContainer = active ? threads.get(active) : null;
      if (activeContainer) {
        emitContainer(activeContainer);
        stateEmitted = true;
      }
    }
  } else if (id === activeId) {
    const next = [...threads.entries()].find(([, thread]) => thread.workspaceId === null)?.[0];
    if (!next) return false;
    activeId = next;
    S = threads.get(next)!;
    emit();
    stateEmitted = true;
  }
  if (!stateEmitted) {
    emit();
  }
  emitThreads();
  return true;
}

/** Test-only reset of the registry to a single empty main thread. */
export function __resetThreadsForTests(): void {
  threads.clear();
  activeThreadIdsByWorkspace.clear();
  seq = 0;
  activeId = MAIN_THREAD;
  S = makeThreadContainer();
  threads.set(MAIN_THREAD, S);
}

/**
 * Reset the agent for a live profile switch: abort any in-flight turns (so no
 * stray turn keeps writing to the DB after it's repointed) and drop every thread
 * back to a single empty main thread. The renderer re-subscribes to `agent:event`
 * after its reload and receives this fresh empty state.
 */
export function resetThreadsForProfileSwitch(): void {
  for (const c of threads.values()) {
    try {
      c.controller?.abort();
    } catch {
      // best-effort — a switch must not be blocked by a stuck abort
    }
  }
  threads.clear();
  activeThreadIdsByWorkspace.clear();
  seq = 0;
  activeId = MAIN_THREAD;
  S = makeThreadContainer();
  threads.set(MAIN_THREAD, S);
}

/* ── event fan-out (renderer push + in-process subscribers) ─────────────── */

// In-process subscribers to the authoritative state stream. The CLI bridge
// companion (electron/cli-bridge) subscribes here to push `agent:event` over SSE
// — the loop's functions are called directly (no IPC), so this is the
// renderer-side push's peer for any non-renderer head. Kept module-level so it
// survives across turns.
const subscribers = new Set<(state: AgentChatState) => void>();

/**
 * Subscribe to the authoritative {@link AgentChatState} stream — every state the
 * renderer would receive on `agent:event` is also delivered here. Used by the
 * in-process CLI bridge companion (electron/cli-bridge). Returns an
 * unsubscribe fn. Callbacks are isolated so one bad subscriber can't break the
 * others or the renderer push.
 */
export function subscribeAgentEvents(cb: (state: AgentChatState) => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

// Workspace-scoped twin of `subscribers`: the bridge server subscribes here so a
// thin client that selected a PC workspace receives that workspace's ACTIVE
// thread stream (the same states the renderer gets on `agent:workspace-event`).
const workspaceSubscribers = new Set<(workspaceId: WorkspaceId, state: AgentChatState) => void>();

/**
 * Subscribe to every workspace-scoped active-thread state push. The callback
 * receives the owning workspaceId with each state so one subscriber (e.g. an SSE
 * connection pinned to a workspace) can filter for its scope. Returns an
 * unsubscribe fn; callbacks are isolated like {@link subscribeAgentEvents}.
 */
export function subscribeWorkspaceAgentEvents(
  cb: (workspaceId: WorkspaceId, state: AgentChatState) => void,
): () => void {
  workspaceSubscribers.add(cb);
  return () => {
    workspaceSubscribers.delete(cb);
  };
}

export const emit = coalesced(() => {
  refreshOrchestrationProjection();
  // Stamp the live approval mode + reasoning effort (settings, not loop state)
  // into the projection so thin clients reflect them (U10 + the reasoning dial).
  // Cheap in-memory reads; the desktop ignores these fields and reads its
  // settings store directly.
  const agentSettings = getSettingsSync().agent;
  S.state.approvalMode = agentSettings.approvalMode;
  S.state.reasoningEffort = agentSettings.reasoningEffort;
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

/** Coalesced push of just the thread list (summaries), for non-active activity. */
export const emitThreads = coalesced(() => {
  const host = getHost();
  if (host && !host.isDestroyed()) {
    host.webContents.send('agent:threads', listThreads());
    for (const workspaceId of workspaceThreadIds()) {
      host.webContents.send('agent:workspace-threads', {
        workspaceId,
        threads: listThreads(workspaceId),
      });
    }
  }
});

// Per-container coalesced flush of the workspace-scoped event. Cached in a
// WeakMap so each container's burst (e.g. per-token streaming during a turn)
// crosses IPC once per tick — the workspace twin of the active-thread `emit` —
// without keeping closed containers alive.
const workspaceEventFlushes = new WeakMap<ThreadContainer, () => void>();

function emitWorkspaceContainer(c: ThreadContainer): void {
  if (!c.workspaceId) return;
  let flush = workspaceEventFlushes.get(c);
  if (!flush) {
    flush = coalesced(() => {
      if (!c.workspaceId) return;
      // Only the ACTIVE thread for a workspace may drive the visible chat. A turn
      // running in a switched-away thread should keep working in the background and
      // refresh the thread list, but must not stream tokens/tool output into the
      // currently viewed conversation.
      if (!isActiveThreadForContainer(c)) return;
      refreshOrchestrationProjection();
      const agentSettings = getSettingsSync().agent;
      c.state.approvalMode = agentSettings.approvalMode;
      c.state.reasoningEffort = agentSettings.reasoningEffort;
      const host = getHost();
      if (host && !host.isDestroyed()) {
        host.webContents.send('agent:workspace-event', { workspaceId: c.workspaceId, state: c.state });
      }
      // The bridge's workspace-scoped stream (a phone joined to this workspace)
      // gets the same active-thread push the renderer just did.
      for (const cb of workspaceSubscribers) {
        try {
          cb(c.workspaceId, c.state);
        } catch {
          // A subscriber must never break the loop's fan-out.
        }
      }
    });
    workspaceEventFlushes.set(c, flush);
  }
  flush();
}

/**
 * Emit for a specific turn's container (Stage 12-B-2). The ACTIVE thread gets the
 * full `agent:event` (it drives the visible chat); a background thread only
 * refreshes its summary in the switcher — so a non-active turn never hijacks the
 * chat the user is looking at. For a single thread, `c` is always active, so this
 * is exactly the old `emit()`.
 *
 * Hot path: this runs on EVERY streamed token delta, so all real work — the
 * orchestration projection rebuild and the IPC sends — happens inside the
 * coalesced flushes (once per tick), never synchronously here. Synchronous
 * readers that need a fresh projection (snapshot()) refresh it themselves.
 */
// Per-container coalesced flush of the THREAD-scoped event. Unlike the workspace
// twin, this fires for EVERY container (active or background) carrying its
// threadId, so a canvas card bound to that thread streams independently — many
// chats live at once. Coalesced per container so a token burst crosses IPC once
// per tick; cached in a WeakMap so closed containers don't leak.
const threadEventFlushes = new WeakMap<ThreadContainer, () => void>();

function emitThreadContainer(c: ThreadContainer): void {
  let flush = threadEventFlushes.get(c);
  if (!flush) {
    flush = coalesced(() => {
      const threadId = idForContainer(c);
      if (!threadId) return;
      refreshOrchestrationProjection();
      const agentSettings = getSettingsSync().agent;
      c.state.approvalMode = agentSettings.approvalMode;
      c.state.reasoningEffort = agentSettings.reasoningEffort;
      const host = getHost();
      if (host && !host.isDestroyed()) {
        host.webContents.send('agent:thread-event', {
          ...(c.workspaceId ? { workspaceId: c.workspaceId } : {}),
          threadId,
          state: c.state,
        });
      }
    });
    threadEventFlushes.set(c, flush);
  }
  flush();
}

export function emitContainer(c: ThreadContainer): void {
  // Every container streams its own thread event (canvas independence), then the
  // existing workspace/global active-thread pushes for classic single-view.
  emitThreadContainer(c);
  emitWorkspaceContainer(c);
  if (c === S) {
    emit();
    return;
  }
  // Workspace-scoped active threads are tracked per workspace instead of by the
  // global S binding. The active workspace thread gets a workspace-event above;
  // every workspace thread (active or background) also refreshes summaries.
  if (c.workspaceId) {
    emitThreads();
    return;
  }
  // Non-active global threads must never call emit(), because that would push the
  // active global S state at the wrong time and can visually hijack the chat.
  emitThreads();
}

function threadProjectionEntries(): OrchestrationThreadEntry[] {
  return [...threads.entries()].map(([id, container]) => ({
    id,
    container,
    active: isActiveThread(id, container),
  }));
}

function isActiveThread(id: string, container: ThreadContainer): boolean {
  if (container.workspaceId) return activeThreadIdsByWorkspace.get(container.workspaceId) === id;
  return id === activeId;
}

function isActiveThreadForContainer(container: ThreadContainer): boolean {
  if (container === S) return true;
  if (!container.workspaceId) return false;
  return activeThreadIdsByWorkspace.get(container.workspaceId) === idForContainer(container);
}

function idForContainer(container: ThreadContainer): string | null {
  for (const [id, candidate] of threads.entries()) {
    if (candidate === container) return id;
  }
  return null;
}

