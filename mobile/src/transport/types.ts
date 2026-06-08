import type {
  AgentChatState,
  AgentAnswers,
  AgentApprovalMode,
  AgentPlanStepStatus,
  AgentSendInput,
} from '../types';

/**
 * The single seam between the mobile UI and "where the agent lives".
 *
 * The phone is a thin client: the entire UI is driven by an {@link AgentChatState}
 * pushed from the transport (`onState`) and a coarse connection {@link TransportStatus}
 * (`onStatus`). The UI sends intent via {@link Transport.send}. Nothing else in the
 * app knows whether that state came from a fake (dev) or a real relay WS — so we can
 * build/demo the whole product against {@link StubTransport} today and swap in
 * `RelayTransport` once the PC-side B2 bridge lands, with zero screen changes.
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
  | 'set-approval-mode';

/** Strongly-typed args per command (the union the UI passes to {@link Transport.send}). */
export type TransportCommandArgs = {
  send: AgentSendInput;
  abort: { turnId: string };
  respond: { turnId: string; callId: string; answers: AgentAnswers };
  approve: { turnId: string; callId: string; approved: boolean };
  reset: Record<string, never>;
  snapshot: Record<string, never>;
  // U5: steer the PC-owned plan — cycle a step's status or remove it.
  'edit-plan-step': { id: string; status?: AgentPlanStepStatus; remove?: boolean };
  // U10: flip the PC's approval mode (applies on the next turn).
  'set-approval-mode': { mode: AgentApprovalMode };
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
}
