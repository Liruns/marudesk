import type { AgentChatState } from '../types';
import {
  b64urlToBytes,
  importAesKey,
  open,
  reqAad,
  resAad,
  seal,
  SSE_AAD,
  type Envelope,
  type SessionKey,
} from '../lib/e2e';
import { messageOf } from '../lib/errorMessage';
import { Emitter } from './emitter';
import type {
  DirectCreds,
  Transport,
  TransportCommand,
  TransportCommandArgs,
  TransportStatusInfo,
  Unsubscribe,
} from './types';

/**
 * Direct (paired) transport for T2 (docs/t2-secure-pairing-design §3/§5): talks to
 * the PC's bridge over LAN/Tailscale with the E2E envelope. Command verbs are
 * AES-GCM-sealed POSTs; the authoritative agent state arrives as an SSE stream of
 * sealed frames, read via fetch + ReadableStream (the WebView's `EventSource`
 * can't send the device header). It implements the SAME {@link Transport} the relay
 * and stub do, so the screens/store don't change. Auto-reconnects the stream on
 * drop. The PC selects the session key from the `X-Marudesk-Device` header;
 * possession of that key is the authentication.
 */

/** REST paths for the POST command verbs (`snapshot` is a GET — see {@link DirectTransport.send}). */
const POST_PATH: Record<Exclude<TransportCommand, 'snapshot'>, string> = {
  send: '/agent/send',
  abort: '/agent/abort',
  respond: '/agent/respond',
  approve: '/agent/approve',
  reset: '/agent/reset',
};

const RECONNECT_MS = 2500;

export class DirectTransport implements Transport {
  private key: SessionKey | null = null;
  private stream: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly stateEmitter = new Emitter<AgentChatState>();
  private readonly statusEmitter = new Emitter<TransportStatusInfo>();

  constructor(private readonly creds: DirectCreds) {}

  async connect(): Promise<void> {
    this.closed = false;
    this.setStatus({ status: 'connecting', hostOnline: false });
    this.key = await importAesKey(b64urlToBytes(this.creds.keyB64));
    void this.openStream();
  }

  disconnect(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stream?.abort();
    this.stream = null;
    this.setStatus({ status: 'disconnected', hostOnline: false });
  }

  onState(cb: (state: AgentChatState) => void): Unsubscribe {
    return this.stateEmitter.subscribe(cb);
  }

  onStatus(cb: (info: TransportStatusInfo) => void): Unsubscribe {
    return this.statusEmitter.subscribe(cb);
  }

  async send<K extends TransportCommand>(cmd: K, args: TransportCommandArgs[K]): Promise<void> {
    const key = this.key;
    if (!key) throw new Error('not connected');

    // `snapshot` is a GET on the host; the SSE already pushes state, but support an
    // explicit pull for parity.
    if (cmd === 'snapshot') {
      const res = await fetch(`${this.creds.baseUrl}/agent/snapshot`, {
        headers: { 'x-marudesk-device': this.creds.deviceId },
      });
      if (!res.ok) throw new Error(`snapshot failed (HTTP ${res.status})`);
      const state = (await open(
        key,
        (await res.json()) as Envelope,
        resAad('/agent/snapshot'),
      )) as AgentChatState;
      this.stateEmitter.emit(state);
      return;
    }

    const path = POST_PATH[cmd as Exclude<TransportCommand, 'snapshot'>];
    const sealed = await seal(key, args, reqAad('POST', path));
    const res = await fetch(`${this.creds.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-marudesk-device': this.creds.deviceId },
      body: JSON.stringify(sealed),
    });
    if (!res.ok) throw new Error(`command failed (HTTP ${res.status})`);
    // The result is sealed too, but we don't need it — the SSE pushes the new state.
  }

  /** Open the encrypted SSE stream; decode each sealed frame to a snapshot. */
  private async openStream(): Promise<void> {
    const key = this.key;
    if (!key || this.closed) return;
    const ac = new AbortController();
    this.stream = ac;
    try {
      const res = await fetch(`${this.creds.baseUrl}/agent/events`, {
        headers: { 'x-marudesk-device': this.creds.deviceId, accept: 'text/event-stream' },
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        this.setStatus({ status: 'error', hostOnline: false, detail: `HTTP ${res.status}` });
        this.scheduleReconnect();
        return;
      }
      this.setStatus({ status: 'connected', hostOnline: true });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = frame.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue; // a ping comment
          try {
            const env = JSON.parse(line.slice('data: '.length)) as Envelope;
            const event = (await open(key, env, SSE_AAD)) as {
              type?: string;
              state?: AgentChatState;
            };
            if (event?.type === 'snapshot' && event.state) this.stateEmitter.emit(event.state);
          } catch {
            // ignore an unparseable / undecryptable frame
          }
        }
      }
      // The server closed the stream — reconnect unless we asked to close.
      if (!this.closed) {
        this.setStatus({ status: 'disconnected', hostOnline: false });
        this.scheduleReconnect();
      }
    } catch (err) {
      if (ac.signal.aborted || this.closed) return;
      this.setStatus({ status: 'disconnected', hostOnline: false, detail: messageOf(err, 'connection lost') });
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openStream();
    }, RECONNECT_MS);
  }

  private setStatus(info: TransportStatusInfo): void {
    this.statusEmitter.emit(info);
  }
}
