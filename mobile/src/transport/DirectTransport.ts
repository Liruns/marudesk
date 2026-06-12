import type {
  AgentChatState,
  BridgeModelsResult,
  BridgeWorkspacesResult,
  SessionSummary,
} from '../types';
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
import { BaseTransport } from './base';
import type {
  DirectCreds,
  Transport,
  TransportCatalog,
  TransportCommand,
  TransportCommandArgs,
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
  'edit-plan-step': '/agent/edit-plan-step',
  'set-approval-mode': '/agent/set-approval-mode',
  'set-reasoning-effort': '/agent/set-reasoning-effort',
  'revert-edit': '/agent/revert-edit',
};

const RECONNECT_MS = 2500;

export class DirectTransport extends BaseTransport implements Transport {
  private key: SessionKey | null = null;
  private stream: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  /** The PC workspace the event stream is pinned to (null = the global chat). */
  private workspaceId: string | null;
  /**
   * Every base URL the PC may answer at (pairing candidates: Tailscale/LAN/
   * tunnel), in failover order. `active` indexes the one currently in use; a
   * failed stream open rotates to the next, so a phone that left the pairing
   * network finds the cross-network address by itself.
   */
  private readonly urls: string[];
  private active = 0;

  constructor(
    private readonly creds: DirectCreds,
    workspaceId: string | null = null,
  ) {
    super();
    this.urls = creds.urls?.length ? creds.urls : [creds.baseUrl];
    this.workspaceId = workspaceId;
  }

  /** The base URL currently in use (commands follow the stream's working address). */
  private base(): string {
    return this.urls[this.active];
  }

  /** Rotate to the next candidate after a failed stream open. */
  private rotate(): void {
    this.active = (this.active + 1) % this.urls.length;
  }

  async connect(): Promise<void> {
    this.closed = false;
    this.setStatus({ status: 'connecting', hostOnline: false });
    this.key = await importAesKey(b64urlToBytes(this.creds.keyB64));
    void this.openStream();
  }

  /**
   * Re-pin the SSE stream to another PC workspace. The server fixes a stream's
   * scope at connect (`?workspace=`), so switching means re-opening it; the new
   * stream's first frame is that workspace's current snapshot, which repaints
   * the chat. No-op before connect() — the pending scope applies when it runs.
   */
  setWorkspace(workspaceId: string | null): void {
    if (workspaceId === this.workspaceId) return;
    this.workspaceId = workspaceId;
    if (!this.key || this.closed) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stream?.abort();
    this.stream = null;
    void this.openStream();
  }

  /** The `?workspace=` suffix for scope-aware GETs ('' when global). */
  private workspaceQuery(): string {
    return this.workspaceId ? `?workspace=${encodeURIComponent(this.workspaceId)}` : '';
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


  async send<K extends TransportCommand>(cmd: K, args: TransportCommandArgs[K]): Promise<void> {
    const key = this.key;
    if (!key) throw new Error('not connected');

    // `snapshot` is a GET on the host; the SSE already pushes state, but support an
    // explicit pull for parity. Pinned to the same workspace scope as the stream.
    if (cmd === 'snapshot') {
      const res = await fetch(`${this.base()}/agent/snapshot${this.workspaceQuery()}`, {
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
    const res = await fetch(`${this.base()}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-marudesk-device': this.creds.deviceId },
      body: JSON.stringify(sealed),
    });
    if (!res.ok) throw new Error(await errorOf(res, `command failed (HTTP ${res.status})`));
    // The result is sealed too, but we don't need it — the SSE pushes the new state.
  }

  /**
   * The PC's picker catalog over the same sealed REST surface. Error bodies are
   * cleartext (only 200 bodies are envelopes), so failures surface the host's
   * message — e.g. a resume refused while a turn is running.
   */
  readonly catalog: TransportCatalog = {
    models: () => this.getSealed('/agent/models', '/agent/models') as Promise<BridgeModelsResult>,
    workspaces: () =>
      this.getSealed('/agent/workspaces', '/agent/workspaces') as Promise<BridgeWorkspacesResult>,
    // `?workspace=` present-but-empty means the global (workspace-less) sessions,
    // matching the host router's filter semantics.
    sessions: (workspaceId) =>
      this.getSealed(
        `/agent/sessions?workspace=${workspaceId ? encodeURIComponent(workspaceId) : ''}`,
        '/agent/sessions',
      ) as Promise<SessionSummary[]>,
    resumeSession: async (id, workspaceId) => {
      const key = this.key;
      if (!key) throw new Error('not connected');
      const path = '/agent/resume-session';
      const body = workspaceId ? { id, workspaceId } : { id };
      const sealed = await seal(key, body, reqAad('POST', path));
      const res = await fetch(`${this.base()}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-marudesk-device': this.creds.deviceId },
        body: JSON.stringify(sealed),
      });
      if (!res.ok) throw new Error(await errorOf(res, `resume failed (HTTP ${res.status})`));
      const out = (await open(key, (await res.json()) as Envelope, resAad(path))) as {
        ok?: boolean;
      };
      return out?.ok === true;
    },
  };

  /** Sealed GET helper: fetch `pathWithQuery`, open the envelope bound to `aadPath`. */
  private async getSealed(pathWithQuery: string, aadPath: string): Promise<unknown> {
    const key = this.key;
    if (!key) throw new Error('not connected');
    const res = await fetch(`${this.base()}${pathWithQuery}`, {
      headers: { 'x-marudesk-device': this.creds.deviceId },
    });
    if (!res.ok) throw new Error(await errorOf(res, `request failed (HTTP ${res.status})`));
    return open(key, (await res.json()) as Envelope, resAad(aadPath));
  }

  /** Open the encrypted SSE stream; decode each sealed frame to a snapshot. */
  private async openStream(): Promise<void> {
    const key = this.key;
    if (!key || this.closed) return;
    const ac = new AbortController();
    this.stream = ac;
    // Whether this attempt got a live stream. A FAILED OPEN rotates to the next
    // candidate URL (the address may be network-specific, e.g. a LAN IP after
    // leaving home); a mid-stream drop doesn't — that address worked, and if it
    // stopped working the next open fails and rotates anyway.
    let opened = false;
    try {
      const res = await fetch(`${this.base()}/agent/events${this.workspaceQuery()}`, {
        headers: { 'x-marudesk-device': this.creds.deviceId, accept: 'text/event-stream' },
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        this.setStatus({ status: 'error', hostOnline: false, detail: `HTTP ${res.status}` });
        this.rotate();
        this.scheduleReconnect();
        return;
      }
      opened = true;
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
      if (!opened) this.rotate();
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

}

/** The host's cleartext `{ error }` body when present, else `fallback`. */
async function errorOf(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (body && typeof body.error === 'string' && body.error.length > 0) return body.error;
  } catch {
    // a non-JSON error body keeps the fallback
  }
  return fallback;
}
