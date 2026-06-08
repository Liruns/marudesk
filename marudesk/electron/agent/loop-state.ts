import type { ModelMessage } from 'ai';
import { coalesced } from '../coalesce';
import { getHost } from '../browser/state';
import { getSettingsSync } from '../settings';
import {
  emptyAgentChatState,
  type AgentAnswers,
  type AgentChatState,
} from '../../shared/agent';

/** Approval decision from the UI: approved/denied, plus "always for this session". */
export type ApprovalDecision = { approved: boolean; always: boolean };

/**
 * The agent loop's authoritative mutable state (docs/agentic-chat-design.md §5),
 * held in one container object so the loop driver and the extracted
 * session/turn/compaction modules can all read and reassign it by reference
 * (ES module `let` bindings can't be reassigned across files). main owns this;
 * the renderer is a pure projection fed by {@link emit}.
 */
export const S = {
  state: emptyAgentChatState() as AgentChatState,
  // The provider-neutral running transcript (multi-turn). Kept valid at all times
  // (every tool_use is answered by a tool_result) so a later turn can reuse it.
  transcript: [] as ModelMessage[],
  controller: null as AbortController | null,
  approvalResolver: null as ((decision: ApprovalDecision) => void) | null,
  // Gated tools the user chose to "Allow always" for this conversation; cleared
  // on reset/resume so it never leaks across conversations.
  sessionAllowedTools: new Set<string>(),
  // Active sticky keyword modes (ultrawork/search/analyze/think) for this
  // conversation; cleared on reset/resume. See keyword-modes.ts.
  activeModes: [] as string[],
  answersResolver: null as ((answers: AgentAnswers) => void) | null,
  // Synchronous re-entrancy guard: status is only set busy after an await in
  // startTurn, so this closes the window before the first await.
  starting: false,
  // The web tab the active turn targets — so finish() can stop the lazy network
  // capture it may have enabled.
  activeTabId: undefined as string | undefined,
  // The current conversation's stable session id + metadata, reused across the
  // conversation's turns; reset() clears it so the next turn begins a new session.
  conversationId: null as string | null,
  conversationStartedAt: 0,
  conversationProvider: '',
  conversationModel: '',
  conversationTitle: '',
  seq: 0,
};

export function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${++S.seq}`;
}

export function busy(): boolean {
  return (
    S.state.status === 'thinking' ||
    S.state.status === 'working' ||
    S.state.status === 'waiting_for_user'
  );
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
  if (host && !host.isDestroyed()) host.webContents.send('agent:event', S.state);
  for (const cb of subscribers) {
    try {
      cb(S.state);
    } catch {
      // A subscriber must never break the loop's fan-out.
    }
  }
});
