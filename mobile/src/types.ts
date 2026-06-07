/**
 * Self-contained type mirror of marudesk's agent + relay-auth wire shapes.
 *
 * IMPORTANT (B3 scoping): this package must NOT cross-import from `marudesk/` or
 * `relay/`. These types are a deliberate, hand-kept copy of the shapes in
 * `marudesk/shared/agent.ts` and the relay-auth shapes in
 * `marudesk/shared/remote.ts`. If the upstream contract changes, update here.
 *
 * The phone is a THIN CLIENT: it renders the PC-owned {@link AgentChatState} and
 * sends agent commands. It never runs the model or tools — every field here is a
 * display/transport shape, not execution state.
 */

/* ── Agent chat state (mirror of marudesk/shared/agent.ts) ──────────────────── */

/** Agent lifecycle. Drives the status badge. */
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
  id: string;
  name: string;
  /** Raw model input. Display-only on the phone. */
  input: unknown;
  state: ToolCallState;
  /** One-line human summary for the card header (e.g. "read src/App.tsx"). */
  summary?: string;
  /** Already-scrubbed + clipped result text shown when the card is expanded. */
  resultText?: string;
  error?: string;
};

export type AgentTextPart = { type: 'text'; text: string };
export type AgentToolPart = { type: 'tool'; call: ToolCall };
/** The model's streamed reasoning ("extended thinking"); collapsible block. */
export type AgentReasoningPart = { type: 'reasoning'; text: string };
/**
 * A `/compact` boundary: the earlier turns were summarized for the model while
 * the scrollback stayed visible. Display-only marker; carries the summary the
 * model now sees. Mirror of marudesk's AgentCompactionPart.
 */
export type AgentCompactionPart = { type: 'compaction'; summary: string; freedTokens?: number };
export type AgentPart =
  | AgentTextPart
  | AgentToolPart
  | AgentReasoningPart
  | AgentCompactionPart;

export type AgentRole = 'user' | 'assistant';

export type AgentMessage = {
  id: string;
  role: AgentRole;
  parts: AgentPart[];
  timestamp: number;
};

/** A pending tool that needs explicit user approval before it runs. */
export type PendingApproval = {
  turnId: string;
  callId: string;
  name: string;
  /** Human-readable preview of what will run (e.g. the JS expression). */
  detail: string;
  /** Proposed edit diffs when this is a file-edit preview (mirrors the host). */
  diffs?: { path: string; before: string; after: string }[];
};

/** A step in the agent's working plan (Taskboard), mirrored from the host. */
export type AgentPlanStep = {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'done';
  note?: string;
  anchorMessageId?: string;
};

/** The agent's working plan, mirrored from the host. */
export type AgentPlan = {
  steps: AgentPlanStep[];
  updatedAt: number;
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

/** The full PC-owned chat state the phone projects. */
export type AgentChatState = {
  turnId: string | null;
  status: AgentStatus;
  messages: AgentMessage[];
  pendingApproval: PendingApproval | null;
  pendingQuestions: PendingQuestions | null;
  usage: { inputTokens: number; outputTokens: number; contextTokens: number };
  /** Set when the latest turn failed; cleared on the next send. */
  error: string | null;
  /** The agent's working plan (Taskboard), or null when there's none. */
  plan: AgentPlan | null;
};

export function emptyAgentChatState(): AgentChatState {
  return {
    turnId: null,
    status: 'idle',
    messages: [],
    pendingApproval: null,
    pendingQuestions: null,
    usage: { inputTokens: 0, outputTokens: 0, contextTokens: 0 },
    error: null,
    plan: null,
  };
}

/** ask_user answers, keyed by {@link AgentQuestion.id}. */
export type AgentAnswers = Record<string, string>;

/**
 * The first-turn agent send input. On the PC this also carries captures + a tab
 * id; the phone keeps just what a thin client needs to start a turn. `provider`
 * and `model` are free strings here (the PC validates against its real registry).
 */
export type AgentSendInput = {
  provider: string;
  model: string;
  prompt: string;
};

/* ── Relay auth wire shapes (mirror of marudesk/shared/remote.ts) ───────────── */

/** The public account the relay returns (no password material). */
export type RelayAccount = {
  id: string;
  method: 'local' | 'google' | 'github';
  email: string;
  displayName?: string;
  createdAt: string;
};

/** `POST /auth/{signup,login}` and `/auth/refresh` token fields. */
export type RelayTokenPair = {
  accessToken: string;
  refreshToken: string;
  expiresInSec: number;
};

/** `POST /auth/{signup,login}` response: the account plus a token pair. */
export type RelayAuthResponse = RelayTokenPair & { account: RelayAccount };
