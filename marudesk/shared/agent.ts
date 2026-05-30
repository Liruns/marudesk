import type { CapturePayload } from './composer';
import type { ProviderId } from './providers';

/**
 * The agentic AI Chat contract (docs/agentic-chat-design.md). main owns the
 * authoritative {@link AgentChatState}; the renderer is a pure projection that
 * replaces its copy from each coalesced `agent:event` snapshot (Karton-style "UI
 * is a projection", without the patch machinery — turns are bounded so a full
 * snapshot per tick is cheap and immune to merge bugs).
 *
 * Pure types only (imports two sibling type modules, no runtime) so both sides
 * share one source of truth. The provider-native message format lives inside the
 * driver; everything here is display/transport shape.
 */

/** Agent lifecycle (stagewise's 7-state enum). Drives the UI status badge. */
export type AgentStatus =
  | 'idle'
  | 'thinking' // model call in flight, no tool yet
  | 'working' // executing tool calls
  | 'waiting_for_user' // parked on approval or a question
  | 'failed'
  | 'completed';

export type ToolCallState =
  | 'awaiting_approval'
  | 'running'
  | 'ok'
  | 'error'
  | 'denied'
  | 'aborted';

/** One model-requested tool call plus its execution state (UI tool card). */
export type ToolCall = {
  /** Provider tool_use id (correlates the result back). */
  id: string;
  name: string;
  /** Raw model input (validated per-tool in the executor). */
  input: unknown;
  state: ToolCallState;
  /** One-line human summary for the card header (e.g. "read src/App.tsx"). */
  summary?: string;
  /** Already scrubbed + clipped result text shown in the expanded card. */
  resultText?: string;
  error?: string;
};

export type AgentTextPart = { type: 'text'; text: string };
export type AgentToolPart = { type: 'tool'; call: ToolCall };
export type AgentPart = AgentTextPart | AgentToolPart;

export type AgentRole = 'user' | 'assistant';

export type AgentMessage = {
  id: string;
  role: AgentRole;
  parts: AgentPart[];
  timestamp: number;
};

/**
 * An edit the agent applied to disk, tracked so the user can accept (keep) or
 * revert (restore `before`) it — roadmap P2 (apply 강화: 멀티파일 / revert). The
 * atomic patch layer already computes `before`; history just persists it.
 */
export type AgentEditStatus = 'applied' | 'accepted' | 'reverted';

export type AgentEdit = {
  id: string;
  turnId: string;
  path: string;
  kind: 'edit' | 'create';
  /** Pre-edit content, or null for a freshly created file. */
  before: string | null;
  after: string;
  status: AgentEditStatus;
  timestamp: number;
};

/** A pending tool that needs explicit user approval before it runs (eval_js, nav). */
export type PendingApproval = {
  turnId: string;
  callId: string;
  name: string;
  /** Human-readable preview of what will run (e.g. the JS expression). */
  detail: string;
};

/** A pending `ask_user` question set that parks the turn until answered. */
export type AgentQuestion = {
  id: string;
  question: string;
  /** Suggested answers; the UI still allows free text. */
  options?: string[];
};

export type PendingQuestions = {
  turnId: string;
  callId: string;
  questions: AgentQuestion[];
};

/** The full server-owned chat state the renderer projects. */
export type AgentChatState = {
  turnId: string | null;
  status: AgentStatus;
  messages: AgentMessage[];
  edits: AgentEdit[];
  pendingApproval: PendingApproval | null;
  pendingQuestions: PendingQuestions | null;
  usage: { inputTokens: number; outputTokens: number };
  /** Set when the latest turn failed; cleared on the next send. */
  error: string | null;
};

export function emptyAgentChatState(): AgentChatState {
  return {
    turnId: null,
    status: 'idle',
    messages: [],
    edits: [],
    pendingApproval: null,
    pendingQuestions: null,
    usage: { inputTokens: 0, outputTokens: 0 },
    error: null,
  };
}

/* ── IPC payloads ───────────────────────────────────────────────────────── */

export type AgentSendInput = {
  provider: ProviderId;
  model: string;
  prompt: string;
  /** Captures selected in the Captures tab, attached as first-turn context. */
  captures: CapturePayload[];
  /** The active web tab, so runtime tools (console/dom/network) have a target. */
  tabId?: string;
};

export type AgentSendResult =
  | { ok: true; turnId: string }
  | { ok: false; reason: string };

/** ask_user answers, keyed by {@link AgentQuestion.id}. */
export type AgentAnswers = Record<string, string>;
