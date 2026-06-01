import type { AgentChatState } from '../types';
import { Emitter } from './emitter';
import type {
  Transport,
  TransportCommand,
  TransportCommandArgs,
  TransportStatusInfo,
  Unsubscribe,
} from './types';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠️  SKELETON — the live wiring lands AFTER the PC-side B2 task finalizes the
 *     relay protocol. Do NOT treat this as functional yet. `StubTransport` is the
 *     default in dev; flip the factory in `src/transport/index.ts` to use this
 *     once B2 is merged.
 *
 * ── B2 INTEGRATION SEAM (exact spec for the human wiring this up) ─────────────
 *
 * 1. CONNECT (outbound WS to the relay; relay/README.md "WebSocket surface"):
 *      ws(s)://<relayUrl host>/connect?role=client&token=<accessToken>
 *    Derive ws/wss from the http/https of `relayUrl`. The relay JWT-authenticates
 *    the upgrade BEFORE acceptance; on success the first frame is:
 *      { type: 'ready', role: 'client', accountId, peers: {hosts, clients} }
 *    Use `peers.hosts > 0` to drive `hostOnline` in the status info (no PC host
 *    online yet ⇒ connected-but-hostOnline:false; show "waiting for PC").
 *
 * 2. INBOUND FRAMES (relay → client) are the relay envelope:
 *      { type: 'relay', from: 'host', payload: <RelayHostMessage> }
 *    where RelayHostMessage (marudesk/shared/remote.ts §3) is one of:
 *      { k: 'event', state: AgentChatState }                 → onState(state)
 *      { k: 'ack', cid, ok, result?, error? }                → resolve pending send()
 *    Validate defensively (mirror `parseRelayHostMessage` from shared/remote.ts —
 *    copy it locally; do NOT cross-import marudesk). Ignore anything malformed.
 *
 * 3. OUTBOUND COMMANDS (client → host): wrap a RelayCommand in the relay's
 *    `{payload}` envelope (the relay hub peels exactly one `payload` layer):
 *      ws.send(JSON.stringify({ payload: { k:'cmd', cid, cmd, args } }))
 *    `cmd` ∈ {'send'|'abort'|'respond'|'approve'|'reset'|'snapshot'} and `args`
 *    is exactly `TransportCommandArgs[cmd]` (these mirror the M4 REST bodies /
 *    AgentSendInput; the PC re-validates with electron/agent/parse.ts). Keep a
 *    Map<cid, {resolve,reject}> and settle it from the matching `ack`. Generate
 *    `cid` with crypto.randomUUID().
 *
 * 4. ON CONNECT: after `ready`, immediately send a `snapshot` command so a phone
 *    that joins mid-session paints the current state (multi-head).
 *
 * 5. AUTH/REFRESH: `accessToken` is short-lived. On a 401-style close (the relay
 *    closes the upgrade if the JWT is invalid/expired) surface status:'error' and
 *    let the app layer refresh via /auth/refresh (see src/auth/relayClient.ts)
 *    and re-`connect`. (Token refresh-on-WS-close is a TODO below.)
 *
 * 6. RESILIENCE: heartbeat — the relay sends ping/pong; the browser WS answers
 *    pings automatically. Add a backoff auto-reconnect on unexpected close, and a
 *    bounded send() timeout that rejects the pending cid.
 * ════════════════════════════════════════════════════════════════════════════
 */

type Pending = { resolve: () => void; reject: (err: Error) => void };

export class RelayTransport implements Transport {
  private ws: WebSocket | null = null;
  private readonly stateEmitter = new Emitter<AgentChatState>();
  private readonly statusEmitter = new Emitter<TransportStatusInfo>();
  private readonly pending = new Map<string, Pending>();

  connect(relayUrl: string, accessToken: string): Promise<void> {
    this.setStatus({ status: 'connecting', hostOnline: false });

    // TODO(B2): build the ws URL + open the socket. Sketch:
    //   const wsUrl = toWsUrl(relayUrl) + `/connect?role=client&token=${encodeURIComponent(accessToken)}`;
    //   this.ws = new WebSocket(wsUrl);
    //   this.ws.onopen    = () => { /* wait for the `ready` frame before 'connected' */ };
    //   this.ws.onmessage = (ev) => this.onFrame(ev.data);
    //   this.ws.onclose   = (ev) => this.onClose(ev);
    //   this.ws.onerror   = () => this.setStatus({ status: 'error', hostOnline: false });
    // For now this is a no-op so the StubTransport-driven UI still builds/runs.
    void relayUrl;
    void accessToken;
    this.setStatus({
      status: 'error',
      hostOnline: false,
      detail: 'RelayTransport is not wired yet (pending B2). Use StubTransport in dev.',
    });
    return Promise.reject(new Error('RelayTransport not implemented (pending B2)'));
  }

  disconnect(): void {
    // TODO(B2): this.ws?.close(1000, 'client disconnect');
    this.ws?.close();
    this.ws = null;
    for (const p of this.pending.values()) p.reject(new Error('disconnected'));
    this.pending.clear();
    this.setStatus({ status: 'disconnected', hostOnline: false });
  }

  onState(cb: (state: AgentChatState) => void): Unsubscribe {
    return this.stateEmitter.subscribe(cb);
  }

  onStatus(cb: (info: TransportStatusInfo) => void): Unsubscribe {
    return this.statusEmitter.subscribe(cb);
  }

  send<K extends TransportCommand>(_cmd: K, _args: TransportCommandArgs[K]): Promise<void> {
    // TODO(B2): wrap as { payload: { k:'cmd', cid, cmd, args } }, send, await the ack.
    //   const cid = crypto.randomUUID();
    //   const frame = { payload: { k: 'cmd', cid, cmd: _cmd, args: _args } };
    //   return new Promise((resolve, reject) => {
    //     if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return reject(new Error('not connected'));
    //     this.pending.set(cid, { resolve, reject });
    //     this.ws.send(JSON.stringify(frame));
    //     // + a setTimeout that rejects + deletes the cid on ack timeout.
    //   });
    return Promise.reject(new Error('RelayTransport not implemented (pending B2)'));
  }

  /* ── inbound handling (skeleton — fill in with the parsers from B2) ──────── */

  // TODO(B2): private onFrame(raw: unknown) {
  //   const envelope = parseRelayFrame(raw);            // { type:'ready' | 'relay', ... }
  //   if (envelope.type === 'ready') { this.setStatus({ status:'connected', hostOnline: envelope.peers.hosts > 0 }); this.send('snapshot', {}); return; }
  //   const msg = parseRelayHostMessage(envelope.payload);   // local copy of shared/remote.ts helper
  //   if (!msg) return;
  //   if (msg.k === 'event') this.stateEmitter.emit(msg.state);
  //   if (msg.k === 'ack') { const p = this.pending.get(msg.cid); if (p) { msg.ok ? p.resolve() : p.reject(new Error(msg.error ?? 'command failed')); this.pending.delete(msg.cid); } }
  // }

  private setStatus(info: TransportStatusInfo): void {
    this.statusEmitter.emit(info);
  }
}

/** Convert an http(s) relay URL to its ws(s) origin (used by the connect TODO above). */
export function toWsUrl(relayUrl: string): string {
  const u = new URL(relayUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  // Strip any trailing slash so we can append `/connect?...`.
  return u.toString().replace(/\/$/, '');
}
