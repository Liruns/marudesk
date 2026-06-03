import type { AgentChatState } from '../types';
import { Emitter } from './emitter';
import { P2pUpgrade } from './p2p';
import { parseRelayFrame, parseRelayHostMessage, parseRtcSignal, type RelayHostMessage } from './relay-frames';
import type {
  Transport,
  TransportCommand,
  TransportCommandArgs,
  TransportStatusInfo,
  Unsubscribe,
} from './types';

/**
 * The phone's OUTBOUND client connection to the cloud relay (Bridge Model B §B3).
 * It dials `ws(s)://<relay>/connect?role=client&token=<JWT>`; the relay forwards
 * opaque payloads to/from the SAME-account PC host (electron/server/relay-client.ts),
 * so the phone drives — and mirrors — the agent loop that lives on the PC.
 *
 *   - inbound `{type:'ready'}`           → connected; `peers.hosts>0` ⇒ a PC is online
 *   - inbound `{type:'relay', payload}`  → a host message: `{k:'event',state}` repaints
 *     the chat; `{k:'ack',cid,ok,…}` settles the matching pending command
 *   - outbound command                   → `{payload:{k:'cmd',cid,cmd,args}}` (the relay
 *     peels exactly one `payload` layer); we await the host's `ack` for that `cid`
 *
 * The relay is a dumb, untrusted pipe: every inbound frame is validated
 * ({@link parseRelayFrame}/{@link parseRelayHostMessage}) before it touches the UI.
 * Resilience: backoff auto-reconnect after an established connection drops, and a
 * bounded per-command timeout so a lost `ack` can't hang the UI. Token refresh on an
 * auth-failed upgrade is the app layer's job (the Transport API only carries the
 * short-lived access token); a never-opened socket surfaces status:'error' so the
 * store can refresh via /auth/refresh and re-`connect`.
 */

type Pending = { resolve: () => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> };

const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 20_000;
/** Reject a command whose `ack` never arrives within this window. */
const COMMAND_TIMEOUT_MS = 20_000;

export class RelayTransport implements Transport {
  private ws: WebSocket | null = null;
  private readonly stateEmitter = new Emitter<AgentChatState>();
  private readonly statusEmitter = new Emitter<TransportStatusInfo>();
  private readonly pending = new Map<string, Pending>();
  /** The direct P2P upgrade, live once a host is online; null = relay-only. */
  private p2p: P2pUpgrade | null = null;

  private relayUrl = '';
  private accessToken = '';
  private hostOnline = false;
  /** Did the CURRENT socket reach the relay `ready` frame? Drives reconnect-vs-auth. */
  private opened = false;
  /** Set by disconnect() so an intentional close doesn't auto-reconnect. */
  private stopped = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  connect(relayUrl: string, accessToken: string): Promise<void> {
    this.relayUrl = relayUrl;
    this.accessToken = accessToken;
    this.stopped = false;
    this.openSocket();
    return Promise.resolve();
  }

  disconnect(): void {
    this.stopped = true;
    this.clearReconnect();
    this.p2p?.stop();
    this.p2p = null;
    this.failAllPending('disconnected');
    const socket = this.ws;
    this.ws = null;
    if (socket) {
      try {
        socket.close(1000, 'client disconnect');
      } catch {
        /* already closing */
      }
    }
    this.hostOnline = false;
    this.setStatus({ status: 'disconnected', hostOnline: false });
  }

  onState(cb: (state: AgentChatState) => void): Unsubscribe {
    return this.stateEmitter.subscribe(cb);
  }

  onStatus(cb: (info: TransportStatusInfo) => void): Unsubscribe {
    return this.statusEmitter.subscribe(cb);
  }

  send<K extends TransportCommand>(cmd: K, args: TransportCommandArgs[K]): Promise<void> {
    const cid = uuid();
    const command = { k: 'cmd', cid, cmd, args };
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(cid);
        reject(new Error(`"${cmd}" timed out`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(cid, { resolve, reject, timer });
      // Prefer the direct P2P channel; fall back to the relay socket. The ack
      // settles `cid` from whichever path the host replies on (handleHostMessage).
      let sent = this.p2p?.send(JSON.stringify(command)) ?? false;
      if (!sent) sent = this.trySendOverRelay(command);
      if (!sent) {
        clearTimeout(timer);
        this.pending.delete(cid);
        reject(new Error('not connected'));
      }
    });
  }

  /** Send a command over the relay socket, wrapped in its `{payload}` envelope. */
  private trySendOverRelay(command: unknown): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify({ payload: command }));
      return true;
    } catch {
      return false;
    }
  }

  /** Send a signaling message to the PC over the relay (P2P handshake only). */
  private sendSignalOverRelay(payload: unknown): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ payload }));
    } catch {
      /* the P2P attempt times out and we stay on the relay */
    }
  }

  /* ── socket lifecycle ──────────────────────────────────────────────────── */

  private openSocket(): void {
    if (this.stopped) return;
    this.opened = false;
    this.setStatus({ status: 'connecting', hostOnline: false });

    let socket: WebSocket;
    const url = `${toWsUrl(this.relayUrl)}/connect?role=client&token=${encodeURIComponent(this.accessToken)}`;
    try {
      socket = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;

    socket.onmessage = (ev: MessageEvent) => {
      this.onFrame(ev.data);
    };
    socket.onclose = () => {
      this.onClose(socket);
    };
    socket.onerror = () => {
      // A WS 'error' is always followed by 'close'; let onClose drive recovery and
      // swallow this so an unhandled 'error' can't surface as an uncaught rejection.
    };
  }

  private onFrame(data: unknown): void {
    const frame = parseRelayFrame(typeof data === 'string' ? data : null);
    if (!frame) return;

    if (frame.type === 'ready') {
      this.opened = true;
      this.attempt = 0;
      this.hostOnline = frame.peers.hosts > 0;
      this.setStatus({ status: 'connected', hostOnline: this.hostOnline, p2p: this.p2p?.isOpen() ?? false });
      // Pull the current state so a phone joining mid-session paints immediately.
      void this.send('snapshot', {}).catch(() => {
        /* a snapshot failure is non-fatal; the next agent:event repaints anyway */
      });
      // If a PC is already online, try to upgrade to a direct P2P channel.
      if (this.hostOnline) this.startP2p();
      return;
    }

    // WebRTC signaling from the host (answer / ICE) rides the relay payload too.
    const signal = parseRtcSignal(frame.payload);
    if (signal) {
      this.p2p?.handleSignal(signal);
      return;
    }

    // A relay envelope from the host: any host traffic means a PC is online.
    const msg = parseRelayHostMessage(frame.payload);
    if (msg) this.handleHostMessage(msg);
  }

  /** Handle a validated host message from EITHER the relay or the P2P channel. */
  private handleHostMessage(msg: RelayHostMessage): void {
    if (!this.hostOnline) {
      this.hostOnline = true;
      this.setStatus({ status: 'connected', hostOnline: true, p2p: this.p2p?.isOpen() ?? false });
      // A host just appeared (and we're relay-connected) — attempt the P2P upgrade.
      this.startP2p();
    }
    if (msg.k === 'event') {
      this.stateEmitter.emit(msg.state);
      return;
    }
    // ack: settle the pending command correlated by cid.
    const p = this.pending.get(msg.cid);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.cid);
    if (msg.ok) p.resolve();
    else p.reject(new Error(msg.error ?? 'command failed'));
  }

  /** Start a single WebRTC upgrade attempt (no-op if one is already in flight). */
  private startP2p(): void {
    if (this.stopped || this.p2p) return;
    const p2p = new P2pUpgrade({
      sid: uuid(),
      sendSignal: (sig) => this.sendSignalOverRelay(sig),
      onHostMessage: (msg) => this.handleHostMessage(msg),
      onOpen: () => {
        if (!this.stopped) this.setStatus({ status: 'connected', hostOnline: true, p2p: true });
      },
      onClose: () => {
        // P2P failed or dropped — drop it and stay on the relay path (still connected).
        if (this.p2p === p2p) this.p2p = null;
        if (!this.stopped) {
          this.setStatus({ status: 'connected', hostOnline: this.hostOnline, p2p: false });
        }
      },
    });
    this.p2p = p2p;
    void p2p.start();
  }

  private onClose(socket: WebSocket): void {
    if (this.ws === socket) this.ws = null;
    if (this.stopped) return;

    // If a direct P2P channel is open, the relay was only a signaling/fallback
    // path: the host is still reachable and in-flight commands still get their
    // acks over the channel. Keep the session up and reconnect the relay quietly.
    if (this.p2p?.isOpen()) {
      this.setStatus({ status: 'connected', hostOnline: true, p2p: true });
      this.scheduleReconnect();
      return;
    }

    // Relay was the only path to the host — it's now unreachable.
    this.hostOnline = false;
    this.failAllPending('connection closed');

    if (!this.opened) {
      // Never reached `ready` — the relay most likely rejected the upgrade (expired
      // or invalid JWT). Surface an error so the app layer can refresh + reconnect;
      // don't spin a refresh-less reconnect storm against a dead token.
      this.setStatus({
        status: 'error',
        hostOnline: false,
        detail: 'Sign-in expired or the relay refused the connection. Reconnect to retry.',
      });
      return;
    }
    // An established connection dropped — auto-reconnect with backoff.
    this.setStatus({ status: 'disconnected', hostOnline: false });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.attempt);
    const delay = Math.round(Math.random() * base); // full jitter
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private failAllPending(reason: string): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private setStatus(info: TransportStatusInfo): void {
    this.statusEmitter.emit(info);
  }
}

/** Convert an http(s) relay URL to its ws(s) origin (no trailing slash). */
export function toWsUrl(relayUrl: string): string {
  const u = new URL(relayUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.toString().replace(/\/$/, '');
}

/** crypto.randomUUID with a tiny fallback for older WebViews that lack it. */
function uuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `cid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
