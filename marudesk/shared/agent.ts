import type { CapturePayload } from './composer';
import type { ProviderId } from './providers';
import type { AgentApprovalMode } from './settings';

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

/**
 * A media file a tool produced (generate_image / generate_video), referenced by
 * its workspace-relative path so the chat can render it inline. Only the path +
 * type travel in the chat state (kept small + session-history friendly); the
 * renderer lazily loads the bytes via the `workspace:read-media` channel.
 */
export type ToolMediaKind = 'image' | 'video';
export type ToolMediaArtifact = {
  kind: ToolMediaKind;
  /** Workspace-relative path of the saved file (e.g. `generated/images/x.png`). */
  path: string;
  /** MIME type of the file, e.g. `image/png` or `video/mp4`. */
  mediaType: string;
};

/**
 * An interactive HTML artifact a tool produced (`create_artifact`, v6 §G4/U6),
 * rendered inline in a SANDBOXED, network-isolated iframe — Claude-Artifacts-style
 * charts/forms/dashboards. The HTML is self-contained (inline CSS/JS); it has no
 * network access and no bridge to tools/files/the app (§S.1: display only).
 */
export type AgentArtifact = {
  /** Short title for the artifact card header. */
  title: string;
  /** Self-contained HTML; rendered with a strict CSP in an opaque-origin frame. */
  html: string;
};

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
  /**
   * Media artifacts produced by this call (generate_image / generate_video),
   * rendered inline in the transcript regardless of verbosity. See
   * {@link ToolMediaArtifact}.
   */
  media?: ToolMediaArtifact[];
  /**
   * An interactive HTML artifact this call produced (`create_artifact`), rendered
   * inline in a sandboxed frame. See {@link AgentArtifact}.
   */
  artifact?: AgentArtifact;
};

export type AgentTextPart = { type: 'text'; text: string };
export type AgentToolPart = { type: 'tool'; call: ToolCall };
/**
 * An image the user pasted/dropped into the composer (claude-code / codex image
 * input parity). `data` is raw base64 (no `data:` prefix); `mediaType` is the
 * MIME type, e.g. `image/png`. Rendered as a thumbnail in the transcript and
 * forwarded to vision-capable models as a multimodal content part.
 */
export type AgentImagePart = { type: 'image'; mediaType: string; data: string };
/**
 * The model's streamed reasoning ("extended thinking"). Display-only — rendered
 * as a collapsible "Thinking" block (Claude/Codex Desktop parity, v3 §5-A) and
 * NOT round-tripped into the provider transcript (avoids the signed-thinking-block
 * round-trip constraints; the loop keeps reasoning out of `ModelMessage[]`).
 */
export type AgentReasoningPart = { type: 'reasoning'; text: string };
/**
 * A compaction boundary in the visible transcript. `/compact` summarizes the
 * earlier turns for the MODEL (replacing them in the context window to save
 * tokens) but keeps the full scrollback visible to the user — this part renders
 * the divider that marks where that happened and carries the summary the model
 * now sees, so the user can expand it to verify what was preserved. Display-only:
 * it is never sent to the model (the summary lives in the transcript instead),
 * which is what makes compaction non-destructive to the user's history.
 */
export type AgentCompactionPart = {
  type: 'compaction';
  /** The summary that replaced the earlier turns in the model's context. */
  summary: string;
  /** Approx. input tokens dropped from the context, for the divider label. */
  freedTokens?: number;
};
export type AgentPart =
  | AgentTextPart
  | AgentToolPart
  | AgentReasoningPart
  | AgentImagePart
  | AgentCompactionPart;

/** A user-attached image forwarded with the first turn (see {@link AgentImagePart}). */
export type AgentImageInput = { mediaType: string; data: string };

export type AgentRole = 'user' | 'assistant';

export type AgentMessage = {
  id: string;
  /** Turn that produced this row; absent for legacy saved sessions/system markers. */
  turnId?: string;
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

/**
 * Result of an accept/revert on an applied edit. `reason` distinguishes a
 * *refused* revert from a generic failure so the UI can explain why nothing
 * happened instead of silently no-op'ing:
 * - `stale`: the file changed since the edit landed — reverting would clobber
 *   newer content, so it's skipped (symmetry with the forward edit guard).
 * - `not-found`: the edit id isn't an applied edit (already resolved / unknown).
 * - `no-workspace`: no workspace is open to write into.
 * - `write-failed`: the disk write/unlink itself failed.
 */
export type AgentEditActionResult = {
  ok: boolean;
  reason?: 'stale' | 'not-found' | 'no-workspace' | 'write-failed';
};

/** A pending tool that needs explicit user approval before it runs (eval_js, nav). */
export type PendingApproval = {
  turnId: string;
  callId: string;
  name: string;
  /** Human-readable preview of what will run (e.g. the JS expression). */
  detail: string;
  /**
   * For an edit_file/multi_edit parked under the "preview" edit-approval setting
   * (v5 §G1): the proposed per-op changes, so the approval card can show the diff
   * BEFORE anything is written. Absent for non-edit approvals.
   */
  diffs?: { path: string; before: string; after: string }[];
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
  /**
   * Token accounting. `inputTokens`/`outputTokens` are cumulative totals for the
   * conversation (billing-style, shown in the usage tooltip). `contextTokens` is
   * the most recent model call's input size — i.e. how full the context window
   * currently is — which drives the usage gauge and the auto-compaction trigger.
   */
  usage: { inputTokens: number; outputTokens: number; contextTokens: number };
  /** Set when the latest turn failed; cleared on the next send. */
  error: string | null;
  /**
   * The saved-session id this conversation persists to — assigned on the first
   * turn after a reset, restored on resume, null for a fresh not-yet-saved chat.
   * Lets the sessions UI highlight which row is the live conversation.
   */
  activeSessionId: string | null;
  /**
   * Short interrupt label for a turn that ended early — user Stop, step limit, or
   * a dropped connection. Shown as a centered system line, NOT pushed into the
   * transcript as a fake assistant message. null when the turn ran to completion
   * or is still running. (Hard errors use {@link error} instead.)
   */
  endNote: string | null;
  /**
   * Detached background agents spawned this conversation (docs/background-agent-design.md).
   * Unlike spawn_subagent (which blocks the parent turn), a background agent runs
   * past the turn that started it; this list is the renderer/bridge projection of
   * the main-process task registry. Read-only here — the model collects results
   * via collect_background_agent and the user cancels via the tray.
   */
  background: BackgroundTask[];
  /**
   * The agent's working plan for multi-step tasks (v5 §G2), maintained by the
   * model via the `update_plan` tool and rendered as a Taskboard. null when the
   * conversation has no active plan. A projection, not user-editable.
   */
  plan: AgentPlan | null;
  /**
   * The current approval mode (a setting, not loop-owned) projected into the
   * state at the emit boundary so thin clients can reflect AND steer it (U10
   * mobile parity). The desktop renderer reads the setting store directly and
   * ignores this; the phone has no settings store, so it relies on this mirror.
   */
  approvalMode: AgentApprovalMode;
};

/** A step's lifecycle in the agent's task plan (Taskboard). */
export type AgentPlanStepStatus = 'pending' | 'in_progress' | 'done';

/** One step in the agent's working plan. */
export type AgentPlanStep = {
  id: string;
  title: string;
  status: AgentPlanStepStatus;
  /** Optional one-line detail or result for the step. */
  note?: string;
  /**
   * The transcript message the agent was at when this step became active, so the
   * Taskboard can jump there (v5 §G2). Set once on the first in_progress/done
   * transition and preserved across plan updates.
   */
  anchorMessageId?: string;
};

/** The agent's working plan — the full ordered step list + last-update time. */
export type AgentPlan = {
  steps: AgentPlanStep[];
  updatedAt: number;
};

/** Lifecycle of a detached background agent. */
export type BackgroundStatus = 'running' | 'done' | 'error' | 'cancelled';

/** A detached background agent task, projected from the main-process registry. */
export type BackgroundTask = {
  id: string;
  /** Short name for the tray entry. */
  label: string;
  /** The delegated task instructions (clipped). */
  task: string;
  provider: ProviderId;
  model: string;
  status: BackgroundStatus;
  startedAt: number;
  /** Set when the task reaches a terminal status, else null. */
  finishedAt: number | null;
  /** The child's final report on success, else null. */
  result: string | null;
  /** The failure/cancellation reason when status is error/cancelled, else null. */
  error: string | null;
  /** Whether the parent already read this with collect_background_agent. */
  collected: boolean;
};

export function emptyAgentChatState(): AgentChatState {
  return {
    turnId: null,
    status: 'idle',
    messages: [],
    edits: [],
    pendingApproval: null,
    pendingQuestions: null,
    usage: { inputTokens: 0, outputTokens: 0, contextTokens: 0 },
    error: null,
    activeSessionId: null,
    endNote: null,
    background: [],
    plan: null,
    approvalMode: 'ask',
  };
}

/* ── IPC payloads ───────────────────────────────────────────────────────── */

export type AgentSendInput = {
  provider: ProviderId;
  model: string;
  prompt: string;
  /** Captures selected in the Captures tab, attached as first-turn context. */
  captures: CapturePayload[];
  /** Images pasted/dropped into the composer, forwarded to vision models. */
  images?: AgentImageInput[];
  /** The active web tab, so runtime tools (console/dom/network) have a target. */
  tabId?: string;
};

export type AgentSendResult =
  | { ok: true; turnId: string }
  | { ok: false; reason: string };

/** ask_user answers, keyed by {@link AgentQuestion.id}. */
export type AgentAnswers = Record<string, string>;
