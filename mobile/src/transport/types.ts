import type {
  AgentChatState,
  AgentAnswers,
  AgentApprovalMode,
  AgentPlanStepStatus,
  AgentSendInput,
  BridgeModelsResult,
  BridgeWorkspacesResult,
  ReasoningEffort,
  SessionSummary,
} from '../types';

/**
 * The single seam between the mobile UI and "where the agent lives".
 *
 * The phone is a thin client: the entire UI is driven by an {@link AgentChatState}
 * pushed from the transport (`onState`) and a coarse connection {@link TransportStatus}
 * (`onStatus`). The UI sends intent via {@link Transport.send}. Nothing else in the
 * app knows whether that state came from the dev stub, the relay WebSocket, or a
 * paired direct PC connection, so screens stay unchanged when the store swaps
 * transports.
 */

/** Coarse connection lifecycle the UI shows in the status pill / Account screen. */
export type TransportStatus =
  | 'idle' // constructed, not connected yet
  | 'connecting'
  | 'connected' // relay reachable AND a PC host is online for this account
  | 'disconnected' // was connected, dropped (auto-reconnect may be in flight)
  | 'error';

export type TransportStatusInfo = {
  status: TransportStatus;
  /** True when a PC host is currently online for this account (vs. relay-only). */
  hostOnline: boolean;
  /**
   * True when a direct WebRTC peer-to-peer data channel to the PC is open, so
   * agent traffic bypasses the cloud relay (relay-only otherwise). Undefined for
   * transports that don't do P2P (stub/direct).
   */
  p2p?: boolean;
  /** Optional human-readable detail for the error/disconnected states. */
  detail?: string;
};

/** The agent commands the phone can drive (mirror marudesk shared/remote.ts RelayCommandName). */
export type TransportCommand =
  | 'send'
  | 'abort'
  | 'respond'
  | 'approve'
  | 'reset'
  | 'snapshot'
  | 'edit-plan-step'
  | 'set-approval-mode'
  | 'set-reasoning-effort';

/** Strongly-typed args per command (the union the UI passes to {@link Transport.send}). */
export type TransportCommandArgs = {
  send: AgentSendInput;
  abort: { turnId: string };
  respond: { turnId: string; callId: string; answers: AgentAnswers };
  approve: { turnId: string; callId: string; approved: boolean };
  // `workspaceId` scopes the new-chat reset to that PC workspace's active thread.
  reset: { workspaceId?: string };
  snapshot: { workspaceId?: string };
  // U5: steer the PC-owned plan — cycle a step's status or remove it.
  'edit-plan-step': { id: string; status?: AgentPlanStepStatus; remove?: boolean };
  // U10: flip the PC's approval mode (applies on the next turn).
  'set-approval-mode': { mode: AgentApprovalMode };
  // The mobile twin of the desktop reasoning dial (applies on the next turn).
  'set-reasoning-effort': { effort: ReasoningEffort };
};

/**
 * Read-mostly catalog the PC serves alongside the command surface: connected
 * providers + models, open workspaces, and saved sessions. Optional on
 * {@link Transport} — the direct (paired) transport and the dev stub provide it;
 * the frozen Model-B relay protocol doesn't carry these, so the relay transport
 * leaves it undefined and the UI hides the pickers.
 */
export type TransportCatalog = {
  /** PC provider catalog + connection state (`GET /agent/models`). */
  models(): Promise<BridgeModelsResult>;
  /** The PC's open workspaces + the active one (`GET /agent/workspaces`). */
  workspaces(): Promise<BridgeWorkspacesResult>;
  /**
   * Saved sessions for one scope: a workspace id, or null for the global
   * (workspace-less) chat (`GET /agent/sessions?workspace=`).
   */
  sessions(workspaceId: string | null): Promise<SessionSummary[]>;
  /**
   * Resume a saved session as the scope's active conversation
   * (`POST /agent/resume-session`). False when the PC refused (busy turn or a
   * cross-workspace record); the next snapshot carries the resumed transcript.
   */
  resumeSession(id: string, workspaceId: string | null): Promise<boolean>;
};

export type Unsubscribe = () => void;

/**
 * Credentials for the direct (paired) transport — the PC's reachable base URL, the
 * device id (public, selects the key on the host), and the b64url AES session key
 * established during pairing. Persisted on the phone (storage.ts); the key is a
 * bearer-equivalent secret for this PC.
 */
export type DirectCreds = { baseUrl: string; deviceId: string; keyB64: string };

export interface Transport {
  /**
   * Open the connection. Idempotent-ish: calling again after a disconnect should
   * reconnect.
   *
   * `relayUrl` + `accessToken` are the *relay* credentials and only apply to
   * relay-backed transports: `RelayTransport` dials the outbound client WS and
   * authenticates with them, and `StubTransport` ignores them. The paired
   * `DirectTransport` connects to a specific PC over the LAN/Tailscale using
   * {@link DirectCreds} captured at construction, so it ignores these args (it
   * may be invoked as `connect()`); a method that takes fewer parameters still
   * satisfies this signature.
   */
  connect(relayUrl: string, accessToken: string): Promise<void>;

  /** Tear down the connection and stop emitting. Safe to call when already closed. */
  disconnect(): void;

  /** Subscribe to authoritative chat-state snapshots. Returns an unsubscribe fn. */
  onState(cb: (state: AgentChatState) => void): Unsubscribe;

  /** Subscribe to connection-status changes. Returns an unsubscribe fn. */
  onStatus(cb: (info: TransportStatusInfo) => void): Unsubscribe;

  /**
   * Send one agent command. Resolves when the command is acknowledged (relay
   * `ack`) or, for the stub, immediately after the fake applies it. Rejects if
   * the transport isn't connected.
   */
  send<K extends TransportCommand>(cmd: K, args: TransportCommandArgs[K]): Promise<void>;

  /** The PC's picker catalog, when this transport can serve it (see {@link TransportCatalog}). */
  readonly catalog?: TransportCatalog;

  /**
   * Pin the agent-state stream to one PC workspace (null = the global chat).
   * Transports that support scoping re-key their event stream so `onState`
   * mirrors that workspace's ACTIVE thread — the conversation the desktop UI
   * shows for it. Optional: the relay transport is global-only.
   */
  setWorkspace?(workspaceId: string | null): void;
}
