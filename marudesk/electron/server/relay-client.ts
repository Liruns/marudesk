// WebSocket client for the outbound host connection. Electron 33's runtime is
// Node 20, which has NO global WebSocket and whose `node:http` doesn't export one
// at runtime (only @types/node declares the type — why `tsc` passed but the
// packaged main crashed). undici 7 was no good either: it calls Node 22+ APIs
// (util.markAsUncloneable) at import time that Node 20 lacks. `ws` is the
// Node-20-safe standard client — and what the B1 relay server already uses.
// See docs/bridge-model-b-design.md §B2.
import { WebSocket } from 'ws';
import type { AgentChatState } from '../../shared/agent';
import {
  parseRelayCommand,
  type RelayAck,
  type RelayHostMessage,
  type RelayStateEvent,
} from '../../shared/remote';
import { dispatchAgentCommand, type AgentApi, type ApprovalGuard } from './dispatch';
import { relayConnectUrl, relayRefresh } from './relay-auth';

/**
 * The PC's OUTBOUND relay host (Bridge Model B §B2). It keeps a single WS to the
 * relay (`/connect?role=host&token=<JWT>`), so a phone-client on the SAME account
 * can drive the SAME agent loop through the cloud:
 *   - inbound relay frame  → peel {payload} → validate command → dispatch to the
 *     loop via the SHARED ./dispatch.ts (same path as the M4 REST router, NO fork)
 *     → reply with an {k:'ack'} (and `snapshot`'s ack carries the state).
 *   - every agent:event    → forwarded as {k:'event',state} so the phone mirrors
 *     the chat (with backpressure: skipped if the socket is saturated, mirroring
 *     the SSE path's writableNeedDrain guard).
 *
 * Robustness: the relay is treated as a dumb, untrusted pipe — every peer payload
 * goes through {@link parseRelayCommand} before touching the loop, the shared
 * dispatcher refuses a remote self-approval of a gated tool while the bridge is
 * exposed (L-1, via {@link RelayClientDeps.approvalGuard}), and the loop mediates
 * the rest (read-only/ask rules unchanged). Connection failures never crash main: we
 * reconnect with bounded backoff and refresh the access token (POST /auth/refresh)
 * on an unauthorized upgrade, stopping cleanly on logout/disable/quit.
 */

/** Tunables (small + fixed; a relay host is a background reconnecting client). */
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** Skip forwarding a state event if the socket has more than this buffered (backpressure). */
const MAX_BUFFERED_BYTES = 1 << 20; // 1 MiB — same order as the relay's per-message cap

export type RelayClientDeps = {
  relayUrl: string;
  accessToken: string;
  refreshToken: string;
  /** The agent loop's public API (injected → unit-testable with a mock loop). */
  agent: AgentApi;
  /** Subscribe to the loop's authoritative state stream; returns an unsubscribe fn. */
  subscribe: (cb: (state: AgentChatState) => void) => () => void;
  /** Persist rotated tokens after a refresh (so a restart resumes the session). */
  onTokens?: (accessToken: string, refreshToken: string) => void;
  /** Notified whenever the host's connected-ness changes (drives the renderer status). */
  onConnectedChange?: (connected: boolean) => void;
  /**
   * T2 L-1: refuse a remote self-approval of a gated tool while the bridge is
   * exposed (docs/t2-secure-pairing-design.md §8) — gated approvals stay on the
   * desktop. Omit ⇒ no restriction.
   */
  approvalGuard?: ApprovalGuard;
};

export type RelayClient = {
  /** True while an authenticated host WS is open. */
  isConnected(): boolean;
  /** Stop reconnecting and close the socket. Idempotent. */
  stop(): void;
};

/**
 * Start the outbound host. Returns immediately with a handle; the connection is
 * established (and re-established) in the background. Never throws.
 */
export function startRelayClient(deps: RelayClientDeps): RelayClient {
  let accessToken = deps.accessToken;
  let refreshToken = deps.refreshToken;
  let ws: WebSocket | null = null;
  let unsubscribe: (() => void) | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let stopped = false;
  let connected = false;
  // After an unauthorized upgrade we refresh ONCE before the next dial; this guard
  // stops a refresh storm if the relay keeps rejecting (e.g. a revoked account).
  let refreshedSinceConnect = false;

  function setConnected(next: boolean): void {
    if (connected === next) return;
    connected = next;
    deps.onConnectedChange?.(next);
  }

  /** Send a host→client message, wrapped in the relay's `{payload}` envelope. */
  function send(message: RelayHostMessage): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ payload: message }));
    } catch {
      // A send race against a closing socket: the reconnect path recovers.
    }
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer) return;
    // Exponential backoff with a cap; full jitter so many hosts don't sync up.
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempt);
    const delay = Math.round(Math.random() * base);
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
    if (typeof reconnectTimer.unref === 'function') reconnectTimer.unref();
  }

  /** Refresh the access token after an unauthorized upgrade. Returns success. */
  async function tryRefresh(): Promise<boolean> {
    if (refreshedSinceConnect) return false;
    refreshedSinceConnect = true;
    try {
      const pair = await relayRefresh(deps.relayUrl, refreshToken);
      accessToken = pair.accessToken;
      refreshToken = pair.refreshToken;
      deps.onTokens?.(accessToken, refreshToken);
      return true;
    } catch {
      // Refresh failed (expired/rotated) — the session is dead. We keep trying to
      // reconnect on backoff in case the relay was merely down; the caller can
      // stop us on a definitive logout.
      return false;
    }
  }

  async function connect(): Promise<void> {
    if (stopped) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(relayConnectUrl(deps.relayUrl, 'host', accessToken));
    } catch {
      // Bad URL / construction failure — back off and retry.
      scheduleReconnect();
      return;
    }
    ws = socket;
    // Did THIS socket reach 'open'? A close without it is a likely-auth failure
    // (the relay 401s the upgrade, closing before 'open') → worth a token refresh.
    let opened = false;

    socket.addEventListener('open', () => {
      if (stopped) {
        try {
          socket.close();
        } catch {
          /* ignore */
        }
        return;
      }
      opened = true;
      attempt = 0;
      refreshedSinceConnect = false;
      setConnected(true);
      // Mirror the SSE path: push the current snapshot immediately so a phone that
      // connected before us renders without waiting for the next agent:event.
      send({ k: 'event', state: deps.agent.snapshot() } satisfies RelayStateEvent);
      // Forward every subsequent state the loop emits, honoring backpressure.
      unsubscribe = deps.subscribe((state) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) return; // saturated client: skip
        send({ k: 'event', state });
      });
    });

    socket.addEventListener('message', (ev) => {
      void handleFrame(ev.data);
    });

    const onDown = (): void => {
      setConnected(false);
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      if (ws === socket) ws = null;
      if (stopped) return;
      // An unauthorized upgrade closes before 'open' (the relay 401s the handshake).
      // If THIS socket never opened, try a one-shot token refresh before the next
      // dial (a closed-but-once-open socket had a valid token — just reconnect).
      if (!opened && !refreshedSinceConnect) {
        void tryRefresh().finally(() => scheduleReconnect());
      } else {
        scheduleReconnect();
      }
    };
    socket.addEventListener('close', onDown);
    socket.addEventListener('error', () => {
      // 'error' is always followed by 'close' for a WS; let onDown drive recovery,
      // but swallow the event so an unhandled 'error' can't surface as a crash.
    });
  }

  /** Handle one inbound relay frame: validate → dispatch → ack. */
  async function handleFrame(data: unknown): Promise<void> {
    const raw = typeof data === 'string' ? data : null;
    if (raw === null) return; // we only speak UTF-8 text frames
    let frame: { type?: unknown; payload?: unknown };
    try {
      frame = JSON.parse(raw) as typeof frame;
    } catch {
      return;
    }
    // The relay wraps a peer message as { type:'relay', from, payload }. Ignore
    // its control frames ('ready') and anything that isn't a relay envelope.
    if (frame.type !== 'relay') return;
    const command = parseRelayCommand(frame.payload);
    if (!command) return; // untrusted/malformed peer payload — drop silently
    const outcome = await dispatchAgentCommand(deps.agent, command.cmd, command.args, deps.approvalGuard);
    const ack: RelayAck = outcome.ok
      ? { k: 'ack', cid: command.cid, ok: true, result: outcome.result }
      : { k: 'ack', cid: command.cid, ok: false, error: outcome.error };
    send(ack);
  }

  void connect();

  return {
    isConnected: () => connected,
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      setConnected(false);
      const socket = ws;
      ws = null;
      if (socket) {
        try {
          socket.close();
        } catch {
          /* already closing */
        }
      }
    },
  };
}
