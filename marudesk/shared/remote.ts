import type {
  AgentAnswers,
  AgentChatState,
  AgentSendInput,
  AgentSendResult,
} from './agent';

/**
 * Wire protocol for the PC-side headless bridge server (docs/remote-mobile-bridge-design
 * §M4). The server runs in the Electron main process and relays the agent loop's
 * authoritative state to a future companion app over SSE (server→client events)
 * plus REST (client→server commands). These are pure types shared by the server
 * and any client; M4 ships only the server scaffold (localhost-only, default-off,
 * bearer-token gated) — auth/pairing/LAN exposure are later phases (M5+).
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

/* ── SSE event envelope (server → client) ───────────────────────────────── */

/**
 * Every SSE `data:` frame on `GET /agent/events` is one of these. M4 emits only
 * `snapshot` (the full {@link AgentChatState}); the discriminated `type` leaves
 * room for leaner deltas later without breaking older clients.
 */
export type RemoteEvent = { type: 'snapshot'; state: AgentChatState };
