import type {
  AgentAnswers,
  AgentChatState,
  AgentSendInput,
  AgentSendResult,
} from './agent';

/**
 * Wire protocol for the CLI bridge's loopback companion (electron/cli-bridge).
 * The companion runs in the Electron main process and pushes the agent loop's
 * authoritative state to a local terminal client over SSE (server→client events)
 * plus REST (client→server commands). These are pure types shared by the
 * companion and its client; it is loopback-only (127.0.0.1, ephemeral port,
 * bearer-token gated) — the loopback origin plus token is the trust boundary.
 *
 * Transport choice: SSE + REST over Node's built-in `node:http` only (no WebSocket
 * library, no new dependency). The `agent:event` snapshot stream maps 1:1 onto SSE
 * data frames; the renderer's IPC invokes map onto REST POSTs.
 */

/** Authorization scheme for every endpoint: `Authorization: Bearer <token>`. */
export const REMOTE_AUTH_SCHEME = 'Bearer';

/** Max accepted JSON request body (bytes). A POST larger than this is rejected 413. */
export const REMOTE_MAX_BODY_BYTES = 256 * 1024;

/** SSE keep-alive comment interval (ms) — periodic `: ping\n\n` so proxies/clients hold the stream. */
export const REMOTE_SSE_PING_MS = 25_000;

/** `GET /health` response — a liveness probe that still requires the token. */
export type RemoteHealth = {
  ok: true;
  name: 'marudesk';
  /** App version (electron `app.getVersion()`). */
  version: string;
};

/* ── REST request bodies (client → server) ──────────────────────────────── */
// These mirror the `agent:*` IPC payloads; the server validates them with the
// SAME parsers the IPC handlers use (electron/agent/parse.ts).

export type RemoteSendBody = AgentSendInput;
export type RemoteAbortBody = { turnId: string };
export type RemoteRespondBody = { turnId: string; callId: string; answers: AgentAnswers };
export type RemoteApproveBody = { turnId: string; callId: string; approved: boolean };

/* ── REST responses (server → client) ───────────────────────────────────── */

export type RemoteSendResponse = AgentSendResult;
/** abort / respond / approve all resolve to a boolean "did it apply" flag. */
export type RemoteBoolResponse = { ok: boolean };
/** `POST /agent/reset` outcome. */
export type RemoteResetResponse = { ok: boolean };

/** Uniform error envelope for 4xx/5xx responses (never carries the token). */
export type RemoteError = { error: string };

/* ── read-mostly catalog routes (chat CLI v2 — docs/chat-cli-tui-design.md §4) ──
 *
 * Served when the router is given the optional `extras` dep (404 otherwise).
 * These are HTTP-only GET conveniences for thin clients (the CLI's `/model` and
 * `/sessions` pickers); they are deliberately NOT AgentCommandNames — they read
 * catalog state rather than driving the agent loop.
 */

/** One provider in `GET /agent/models` — its catalog + whether it's usable. */
export type BridgeProviderModels = {
  /** ProviderId (kept as string here so the wire type stays dependency-light). */
  id: string;
  label: string;
  /** A credential/OAuth connection is stored (or the provider is keyless). */
  connected: boolean;
  /** Grouped last under "Experimental" by pickers, like the desktop's. */
  experimental?: boolean;
  /** The provider's suggested default model id, when it has one. */
  defaultModelId?: string;
  models: { id: string; label: string }[];
};

/** `GET /agent/models` response. */
export type BridgeModelsResult = { providers: BridgeProviderModels[] };

/** One agent role / skill entry in `GET /agent/catalog`. */
export type BridgeCatalogEntry = {
  name: string;
  description: string;
  /** 'builtin' | 'user' | 'project' (kept as string so the wire type stays light). */
  scope: string;
  /** Agents only: the model preference (`fast`/`smart`/`inherit` or `provider/model`). */
  model?: string;
};

/**
 * `GET /agent/catalog?workspace=<id>` response: the subagent roles + skills the
 * agent can use (built-in + user + the scoped workspace's project definitions),
 * for the CLI's `/agents` and `/skills` commands.
 */
export type BridgeCatalogResult = {
  agents: BridgeCatalogEntry[];
  skills: BridgeCatalogEntry[];
};

/** One open PC workspace in `GET /agent/workspaces` — id + display name only. */
export type BridgeWorkspaceInfo = {
  id: string;
  name: string;
};

/**
 * `GET /agent/workspaces` response: the PC's open workspaces plus which one is
 * active in the desktop UI, so a thin client can join the chat the user is
 * actually looking at. `activeWorkspaceId: null` ⇒ no workspace is open (the
 * global, workspace-less chat).
 */
export type BridgeWorkspacesResult = {
  workspaces: BridgeWorkspaceInfo[];
  activeWorkspaceId: string | null;
};

/**
 * `GET /agent/session?id=<id>` response: a single session's metadata + flattened
 * transcript for the CLI `/history` command. `null` when the session doesn't exist.
 */
export type BridgeSessionDetail = {
  title: string;
  provider: string;
  model: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  transcript: string;
};

/**
 * `POST /agent/resume-session` request body. `workspaceId` scopes the resume to
 * that workspace's active thread (the loop refuses a cross-workspace resume);
 * omitted ⇒ the global (workspace-less) thread, the pre-workspace behavior.
 */
export type RemoteResumeSessionBody = { id: string; workspaceId?: string };

/* ── remote edit-diff projection ─────────────────────────────────────────────
 *
 * The authoritative state keeps each agent edit as FULL before/after content
 * (shared/agent.ts AgentEdit) — fine over IPC, unbounded over the bridge. The
 * bridge boundary (electron/cli-bridge/remote-state.ts) therefore stamps a bounded
 * `editDiffs` view onto every snapshot it publishes: per edit, a clipped unified
 * diff plus the ids/status a terminal client needs to render a review card and send
 * `revert-edit`. Purely ADDITIVE — a client that never reads it ignores the extra
 * field, and the heavy `edits` array it never reads is emptied to keep frames small.
 */

/** Hard cap on one projected unified diff (chars); clipped with a marker line. */
export const REMOTE_EDIT_DIFF_MAX_CHARS = 20_000;

/** Newest-last cap on the projected edit list (one conversation's review tail). */
export const REMOTE_EDIT_DIFF_MAX_ENTRIES = 50;

/** Mirrors shared/agent.ts AgentEditStatus (kept inline so the wire type is light). */
export type RemoteEditStatus = 'applied' | 'accepted' | 'reverted';

/** One agent file edit as a thin client sees it — bounded, display + act-by-id. */
export type RemoteEditDiff = {
  /** The edit id `revert-edit` acts on. */
  id: string;
  /** The turn that produced the edit (groups cards under the right reply). */
  turnId: string;
  /** Workspace-root-qualified display label (the edit's workspace-relative path). */
  label: string;
  kind: 'edit' | 'create';
  status: RemoteEditStatus;
  /** Unified diff text, clipped to {@link REMOTE_EDIT_DIFF_MAX_CHARS}. */
  diff: string;
  /** Added/removed line counts of the full (pre-clip) change. */
  additions: number;
  deletions: number;
  /** True when `diff` was clipped (the full change is visible on the desktop). */
  truncated: boolean;
  timestamp: number;
};

/**
 * The state shape the bridge actually publishes: the authoritative
 * {@link AgentChatState} plus the optional bounded edit projection. Optional so
 * older hosts (which never stamp it) and older clients (which never read it)
 * stay wire-compatible in both directions.
 */
export type RemoteAgentState = AgentChatState & { editDiffs?: RemoteEditDiff[] };

/** `POST /agent/revert-edit` body. */
export type RemoteRevertEditBody = { editId: string; workspaceId?: string };

/* ── SSE event envelope (server → client) ───────────────────────────────── */

/**
 * Every SSE `data:` frame on `GET /agent/events` is one of these. M4 emits only
 * `snapshot` (the full {@link AgentChatState}); the discriminated `type` leaves
 * room for leaner deltas later without breaking older clients.
 */
export type RemoteEvent = { type: 'snapshot'; state: AgentChatState };

/* ── agent command verbs (the loopback bridge's POST routes) ───────────────── */

/**
 * The agent commands the CLI bridge accepts as `POST /agent/*` routes, validated
 * by the shared electron/agent/parse.ts parsers in the dispatcher. The union is
 * the single source of truth both the router's route table and the dispatcher key
 * off, so the REST surface and the loop semantics can't drift.
 */
export type AgentCommandName =
  | 'send'
  | 'abort'
  | 'respond'
  | 'approve'
  | 'reset'
  | 'snapshot'
  | 'edit-plan-step'
  | 'set-approval-mode'
  | 'set-reasoning-effort'
  | 'revert-edit';
