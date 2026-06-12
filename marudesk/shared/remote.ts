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

/* ── read-mostly catalog routes (chat CLI v2 — docs/chat-cli-tui-design.md §4) ──
 *
 * Served when the router is given the optional `extras` dep (404 otherwise).
 * These are HTTP-only conveniences for thin clients (the CLI's `/model` and
 * `/sessions` pickers); they are deliberately NOT RelayCommandNames — the frozen
 * Model-B relay protocol doesn't change.
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

/* ── SSE event envelope (server → client) ───────────────────────────────── */

/**
 * Every SSE `data:` frame on `GET /agent/events` is one of these. M4 emits only
 * `snapshot` (the full {@link AgentChatState}); the discriminated `type` leaves
 * room for leaner deltas later without breaking older clients.
 */
export type RemoteEvent = { type: 'snapshot'; state: AgentChatState };

/* ── Bridge Model B: relay app-level protocol (docs/bridge-model-b-design.md §3) ──
 *
 * These messages ride INSIDE the relay's opaque `payload` (the relay is a dumb
 * pipe — it forwards `{ type:'relay', from, payload }` and never inspects the
 * payload). PC-host and the phone-client agree on this small discriminated union,
 * which mirrors the M4 SSE/REST surface 1:1: a client `cmd` is the matching
 * `/agent/*` endpoint (validated by the SAME electron/agent/parse.ts parsers the
 * REST router uses), and the host replies with an `ack` + pushes `event` snapshots
 * on every agent:event. Both sides treat peer messages as UNTRUSTED — the relay
 * does no validation, so {@link parseRelayCommand} is the trust boundary on the
 * host and the client validates `event`/`ack` shape on its side.
 */

/** The agent commands a client may drive over the relay (mirror the M4 REST verbs). */
export type RelayCommandName =
  | 'send'
  | 'abort'
  | 'respond'
  | 'approve'
  | 'reset'
  | 'snapshot'
  | 'edit-plan-step'
  | 'set-approval-mode'
  | 'set-reasoning-effort';

export const RELAY_COMMANDS: readonly RelayCommandName[] = [
  'send',
  'abort',
  'respond',
  'approve',
  'reset',
  'snapshot',
  // U5/U10 mobile parity: steer the PC-owned plan + flip the approval mode.
  'edit-plan-step',
  'set-approval-mode',
  // Mobile parity for the desktop composer's reasoning dial (same shape as U10).
  'set-reasoning-effort',
];

/**
 * client → host. `cid` correlates the {@link RelayAck} reply. `args` is the same
 * shape the matching M4 endpoint / parse.ts validator expects (e.g. `send` →
 * AgentSendInput); it stays `unknown` here because the host re-validates it with
 * the shared parsers — the wire type never short-circuits that check.
 */
export type RelayCommand = {
  k: 'cmd';
  cid: string;
  cmd: RelayCommandName;
  args: unknown;
};

/** host → client: the authoritative chat state, pushed on every agent:event. */
export type RelayStateEvent = { k: 'event'; state: AgentChatState };

/** host → client: the reply to one {@link RelayCommand}, correlated by `cid`. */
export type RelayAck = {
  k: 'ack';
  cid: string;
  ok: boolean;
  /** The command result (e.g. AgentSendResult for `send`, AgentChatState for `snapshot`). */
  result?: unknown;
  /** Set when `ok` is false — a human-readable validation/dispatch error. */
  error?: string;
};

/** Everything a host sends to a client. */
export type RelayHostMessage = RelayStateEvent | RelayAck;
/** Everything a client sends to a host. */
export type RelayClientMessage = RelayCommand;

/**
 * Defensively parse an inbound peer payload into a {@link RelayCommand}, or return
 * null if it isn't a well-formed command. The relay forwards arbitrary peer bytes
 * unvalidated, so the host MUST treat this as untrusted: we check the discriminant,
 * `cid`, and a known `cmd`, but leave `args` opaque (the loop's own parse.ts
 * validators are the deep check). Total + never throws.
 */
export function parseRelayCommand(payload: unknown): RelayCommand | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (p.k !== 'cmd') return null;
  if (typeof p.cid !== 'string' || p.cid.length === 0) return null;
  if (typeof p.cmd !== 'string' || !(RELAY_COMMANDS as readonly string[]).includes(p.cmd)) {
    return null;
  }
  return { k: 'cmd', cid: p.cid, cmd: p.cmd as RelayCommandName, args: p.args };
}

/**
 * Defensively parse an inbound host message (for the client side / harness): an
 * `event` carrying a state, or an `ack`. Returns null on anything malformed.
 */
export function parseRelayHostMessage(payload: unknown): RelayHostMessage | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (p.k === 'event') {
    return p.state && typeof p.state === 'object'
      ? { k: 'event', state: p.state as AgentChatState }
      : null;
  }
  if (p.k === 'ack') {
    if (typeof p.cid !== 'string' || typeof p.ok !== 'boolean') return null;
    return {
      k: 'ack',
      cid: p.cid,
      ok: p.ok,
      result: p.result,
      error: typeof p.error === 'string' ? p.error : undefined,
    };
  }
  return null;
}

/* ── WebRTC signaling (docs/webrtc-p2p-design.md) ─────────────────────────────
 *
 * To avoid relaying every byte of agent traffic through the cloud (and to work
 * across NATs without Tailscale), the phone and PC negotiate a direct WebRTC
 * RTCDataChannel and run the SAME {@link RelayCommand}/{@link RelayHostMessage}
 * protocol over it. The negotiation (SDP offer/answer + ICE candidates) is the
 * ONLY thing that still rides the relay — and because the relay is a payload-
 * agnostic pipe, these `rtc-*` messages pass through it UNCHANGED (no relay code
 * change). The phone is the offerer; the PC is the answerer. Once the channel is
 * open, the relay path stays as a hot fallback for hostile NATs (ICE failure).
 *
 * `sid` is a per-attempt session id the offerer mints so concurrent phones (or a
 * stale retry) can't cross-wire: each side ignores signals whose `sid` it didn't
 * start / accept. Both peers treat these as UNTRUSTED (they arrive over the dumb
 * relay), so {@link parseRtcSignal} validates shape before WebRTC ever sees it.
 */

/** A serialized ICE candidate (the wire form of RTCIceCandidateInit). */
export type RtcIceCandidate = {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
};

/** client → host: the phone's SDP offer that starts a P2P attempt. */
export type RtcOffer = { k: 'rtc-offer'; sid: string; sdp: string };
/** host → client: the PC's SDP answer for a given attempt. */
export type RtcAnswer = { k: 'rtc-answer'; sid: string; sdp: string };
/** Either direction: one trickled ICE candidate (`candidate: null` = end-of-candidates). */
export type RtcIce = { k: 'rtc-ice'; sid: string; candidate: RtcIceCandidate | null };

/** Everything exchanged over the relay purely to bootstrap the P2P data channel. */
export type RtcSignal = RtcOffer | RtcAnswer | RtcIce;

/** The relay payload `k` discriminators that carry WebRTC signaling. */
export const RTC_SIGNAL_KINDS: readonly RtcSignal['k'][] = ['rtc-offer', 'rtc-answer', 'rtc-ice'];

function parseIceCandidate(value: unknown): RtcIceCandidate | null {
  if (!value || typeof value !== 'object') return null;
  const c = value as Record<string, unknown>;
  if (typeof c.candidate !== 'string') return null;
  return {
    candidate: c.candidate,
    sdpMid: typeof c.sdpMid === 'string' ? c.sdpMid : null,
    sdpMLineIndex: typeof c.sdpMLineIndex === 'number' ? c.sdpMLineIndex : null,
  };
}

/**
 * Defensively parse an inbound relay payload into a {@link RtcSignal}, or null if
 * it isn't one (so a caller can fall through to {@link parseRelayCommand} /
 * {@link parseRelayHostMessage}). Total + never throws; every field is checked
 * because the relay forwards arbitrary peer bytes.
 */
export function parseRtcSignal(payload: unknown): RtcSignal | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.sid !== 'string' || p.sid.length === 0) return null;
  if (p.k === 'rtc-offer' || p.k === 'rtc-answer') {
    return typeof p.sdp === 'string' && p.sdp.length > 0
      ? { k: p.k, sid: p.sid, sdp: p.sdp }
      : null;
  }
  if (p.k === 'rtc-ice') {
    // `candidate: null` is a valid end-of-candidates marker.
    const candidate = p.candidate === null ? null : parseIceCandidate(p.candidate);
    if (p.candidate !== null && candidate === null) return null;
    return { k: 'rtc-ice', sid: p.sid, candidate };
  }
  return null;
}

/* ── Relay account / auth wire shapes (relay/src/http/router.ts) ──────────── */

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

/**
 * The sanitized cloud-relay status the renderer is allowed to see — never the
 * tokens. `account` is the logged-in account (or null when logged out);
 * `connected` is whether the PC currently holds an outbound host WS to the relay.
 */
export type RelayStatus = {
  account: RelayAccount | null;
  connected: boolean;
};

/* ── LAN/Tailscale direct bridge status (T2 — docs/remote-mobile-bridge-design §3) ──
 *
 * Unlike the cloud relay (both sides dial OUT to marudesk's server), T2 has the
 * phone connect DIRECTLY to this PC over the LAN or a Tailscale tunnel. The PC
 * can't know its own reachable address from inside, so main enumerates every
 * plausible base URL (electron/server/pairing-urls.ts) and the Settings UI shows
 * them (and a future pairing QR encodes them) for the phone to try in order.
 */

/**
 * One reachable base URL for the bridge server, surfaced to the Settings UI.
 * Computed in main from Tailscale (cross-network, tried first) + private LAN IPs.
 */
export type ConnectCandidate = {
  /** Human label — "Tailscale", "Tailscale DNS", or the network-interface name. */
  label: string;
  /** Base URL a client should try, e.g. `http://100.101.102.103:8787`. */
  url: string;
};

/**
 * The sanitized bridge-server status the renderer may see (`server:status`, pushed
 * live on `server:status-changed`). Never carries the bearer token — only whether
 * the server is listening, the bound port, and where it's reachable.
 */
export type ServerStatus = {
  /** Whether the bridge server is currently listening. */
  running: boolean;
  /** The port it's bound to while running, else null. */
  port: number | null;
  /** Reachable base URLs (Tailscale-first, then LAN); empty when stopped. */
  candidates: ConnectCandidate[];
};

/* ── device pairing (T2 ③ — docs/t2-secure-pairing-design.md §2/§4) ─────────── */

/**
 * A paired phone as the Settings UI sees it — NEVER the session key (that lives
 * safeStorage-encrypted in main). `fingerprint` is a short hash of the device's
 * public key, shown so the user can tell devices apart / match the approval card.
 */
export type PairedDeviceInfo = {
  deviceId: string;
  name: string;
  fingerprint: string;
  /** ISO timestamp the device was paired. */
  createdAt: string;
  /** ISO timestamp of the device's last request, or null if it hasn't connected since. */
  lastSeenAt: string | null;
};

/**
 * A live pairing request awaiting the PC user's approve/reject (pushed on
 * `server:pairing-request`). `approvalId` correlates the `server:pairing-approve`
 * / `-reject` reply; the card shows the phone-supplied `name` + the `fingerprint`.
 */
export type PairingRequestInfo = {
  approvalId: string;
  name: string;
  fingerprint: string;
};

/** `server:pairing-start` result — the QR string to render + the code/expiry for the UI. */
export type PairingStartInfo = {
  /** The base64url QR payload (encode as a QR; also shown as a manual code fallback). */
  qr: string;
  /** The one-time pairing code (shown under the QR for manual entry). */
  code: string;
  /** Epoch ms the code/QR expires. */
  expiresAt: number;
};
