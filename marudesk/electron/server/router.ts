import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AgentChatState } from '../../shared/agent';
import {
  REMOTE_MAX_BODY_BYTES,
  REMOTE_SSE_PING_MS,
  type RelayCommandName,
  type RemoteEvent,
} from '../../shared/remote';
import {
  open,
  reqAad,
  resAad,
  seal,
  SSE_AAD,
  type Envelope,
  type SessionKey,
} from '../../shared/e2e';
import { dispatchAgentCommand, type AgentApi } from './dispatch';
import type { DeviceResolver } from './devices';
import type { PairOutcome } from './pairing';
import { verifyToken } from './token';

/**
 * The pure, dependency-injected request handler for the bridge server
 * (docs/remote-mobile-bridge-design §M4, T2 secure pairing in
 * docs/t2-secure-pairing-design.md). Everything it touches arrives via
 * {@link RouterDeps} — the agent loop's functions, the bearer token, the event
 * subscribe fn, and (for T2) the device-key resolver + `/pair` handler — so it is
 * unit-testable headlessly with mocked deps, no Electron (see harness.ts /
 * pair-harness.ts).
 *
 * Two authenticated paths reach the same agent routes:
 *  - BEARER (loopback companion / tests): `Authorization: Bearer <token>`, bodies
 *    and responses in cleartext JSON.
 *  - E2E (paired phone over LAN/Tailscale): an `X-Marudesk-Device: <id>` header
 *    selects the device's session key; request bodies + responses + SSE frames are
 *    AES-GCM envelopes. Possession of the key IS the authentication — a body that
 *    won't open is a 401. AAD binds each envelope to its method/path/direction.
 *
 * `/pair` is the ONLY anonymous route (it's gated by the one-time code + a
 * key-possession proof inside {@link RouterDeps.pair}); every other route requires
 * one of the two auth paths, checked before any work.
 */

export type RouterDeps = {
  /** The server bearer secret (never logged). */
  token: string;
  /** App version for the /health probe. */
  version: string;
  /** The agent loop's public API (electron/agent/loop.ts), injected for testability. */
  agent: AgentApi;
  /** Subscribe to the loop's state stream; returns an unsubscribe fn. */
  subscribe(cb: (state: AgentChatState) => void): () => void;
  /** T2 E2E: resolve a paired device's key + note activity. Omit ⇒ the E2E path is off. */
  devices?: DeviceResolver;
  /** T2 E2E: handle `POST /pair`. Omit ⇒ `/pair` returns 404 (pairing disabled). */
  pair?: (body: unknown) => Promise<PairOutcome>;
};

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' } as const;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  // Error bodies are ALWAYS cleartext (never sealed) so a client can read them
  // whether or not it holds a key; only 200 bodies are encrypted on the E2E path.
  sendJson(res, status, { error: message });
}

/** Pull the bearer token out of the Authorization header, or null if absent/malformed. */
function bearerFrom(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  // Case-insensitive scheme + one-or-more spaces (RFC 7235/6750); a third-party
  // client shouldn't 401 over header casing/whitespace. The captured value is then
  // length + constant-time compared, so loosening the wrapper doesn't weaken it.
  const m = /^Bearer\s+(\S.*)$/i.exec(header);
  return m ? m[1] : null;
}

/** Read a capped JSON body; reject (and respond) on overflow or bad content-type/JSON. */
function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // POSTs must be JSON — reject any other declared content type up front so we
    // never feed e.g. form/multipart bytes into JSON.parse.
    const ctype = req.headers['content-type'];
    if (ctype !== undefined && !/^application\/json\b/i.test(ctype)) {
      sendError(res, 415, 'Content-Type must be application/json');
      reject(new Error('unsupported content type'));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    const fail = (status: number, message: string): void => {
      if (aborted) return;
      aborted = true;
      req.destroy();
      sendError(res, status, message);
      reject(new Error(message));
    };
    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > REMOTE_MAX_BODY_BYTES) {
        fail(413, 'request body too large');
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        fail(400, 'invalid JSON body');
      }
    });
    req.on('error', () => fail(400, 'error reading request body'));
  });
}

/* ── per-request codec: cleartext (bearer) vs AES-GCM envelopes (E2E) ───────── */

/**
 * Translates request bodies, response results, and SSE frames between the wire and
 * the loop. The bearer path is the identity codec; the E2E path seals/opens with
 * the device's session key, binding every message to its endpoint via AAD.
 */
type Codec = {
  /** Decode a parsed POST body into the command args. Throws ⇒ the caller 401s. */
  decodeBody(raw: unknown, method: string, path: string): Promise<unknown>;
  /** Encode a successful result into the response body. */
  encodeResult(result: unknown, path: string): Promise<unknown>;
  /** Encode one SSE event into a full `data: …\n\n` frame. */
  sse(event: RemoteEvent): Promise<string>;
};

const PLAIN_CODEC: Codec = {
  decodeBody: (raw) => Promise.resolve(raw),
  encodeResult: (result) => Promise.resolve(result),
  sse: (event) => Promise.resolve(`data: ${JSON.stringify(event)}\n\n`),
};

function e2eCodec(key: SessionKey): Codec {
  return {
    decodeBody: (raw, method, path) => open(key, raw as Envelope, reqAad(method, path)),
    encodeResult: (result, path) => seal(key, result, resAad(path)),
    sse: async (event) => `data: ${JSON.stringify(await seal(key, event, SSE_AAD))}\n\n`,
  };
}

async function sendResult(
  res: ServerResponse,
  codec: Codec,
  path: string,
  result: unknown,
): Promise<void> {
  sendJson(res, 200, await codec.encodeResult(result, path));
}

/**
 * Stream agent:event snapshots as SSE, encoded per `frame`. Writes are serialized
 * through a tail promise so async (E2E) sealing can't reorder frames, and shed
 * under socket backpressure so a stalled client can't grow main-process memory.
 */
function handleSse(
  req: IncomingMessage,
  res: ServerResponse,
  frame: (event: RemoteEvent) => Promise<string>,
  deps: RouterDeps,
): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  let tail: Promise<void> = Promise.resolve();
  const push = (event: RemoteEvent): void => {
    if (res.writableEnded || res.writableNeedDrain) return;
    tail = tail
      .then(async () => {
        if (res.writableEnded || res.writableNeedDrain) return;
        res.write(await frame(event));
      })
      .catch(() => {
        // A seal/write failure shouldn't wedge the chain; the next emit carries the
        // latest full snapshot anyway.
      });
  };

  // First frame: the current snapshot, so a fresh client renders immediately.
  push({ type: 'snapshot', state: deps.agent.snapshot() });
  const unsubscribe = deps.subscribe((state) => push({ type: 'snapshot', state }));

  const ping = setInterval(() => res.write(': ping\n\n'), REMOTE_SSE_PING_MS);
  if (typeof ping.unref === 'function') ping.unref();

  const cleanup = (): void => {
    clearInterval(ping);
    unsubscribe();
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
}

const REST_COMMANDS: Record<string, RelayCommandName> = {
  '/agent/send': 'send',
  '/agent/abort': 'abort',
  '/agent/respond': 'respond',
  '/agent/approve': 'approve',
  '/agent/reset': 'reset',
};

/**
 * The shared agent route table, reached by both auth paths with the matching
 * {@link Codec}. GET health/snapshot/events + POST command verbs (dispatched
 * through the SAME validator the relay uses, so REST and relay can't drift).
 */
async function handleAgentRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RouterDeps,
  pathname: string,
  method: string,
  codec: Codec,
): Promise<void> {
  if (pathname === '/health') {
    if (method !== 'GET') return sendError(res, 405, 'method not allowed');
    return sendResult(res, codec, pathname, { ok: true, name: 'marudesk', version: deps.version });
  }
  if (pathname === '/agent/snapshot') {
    if (method !== 'GET') return sendError(res, 405, 'method not allowed');
    return sendResult(res, codec, pathname, deps.agent.snapshot());
  }
  if (pathname === '/agent/events') {
    if (method !== 'GET') return sendError(res, 405, 'method not allowed');
    handleSse(req, res, codec.sse, deps);
    return;
  }

  const cmd = REST_COMMANDS[pathname];
  if (cmd) {
    if (method !== 'POST') return sendError(res, 405, 'method not allowed');
    let raw: unknown;
    try {
      raw = await readJsonBody(req, res);
    } catch {
      return; // readJsonBody already wrote the 4xx response
    }
    let args: unknown;
    try {
      args = await codec.decodeBody(raw, method, pathname);
    } catch {
      // E2E only: a body that won't open isn't authentic for this device → 401.
      return sendError(res, 401, 'unauthorized');
    }
    const outcome = await dispatchAgentCommand(deps.agent, cmd, args);
    if (!outcome.ok) return sendError(res, 400, outcome.error);
    return sendResult(res, codec, pathname, outcome.result);
  }

  sendError(res, 404, 'not found');
}

/**
 * Route + handle one request. Resolves once the response has been written. `/pair`
 * is the only anonymous route; everything else requires the E2E device key or the
 * bearer token, authenticated before any work.
 */
export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RouterDeps,
): Promise<void> {
  let pathname: string;
  try {
    pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  } catch {
    sendError(res, 400, 'bad request');
    return;
  }
  const method = req.method ?? 'GET';

  // ── pairing (anonymous; gated by the one-time code + key-possession proof) ──
  if (pathname === '/pair') {
    if (method !== 'POST') return sendError(res, 405, 'method not allowed');
    if (!deps.pair) return sendError(res, 404, 'not found');
    let body: unknown;
    try {
      body = await readJsonBody(req, res);
    } catch {
      return;
    }
    const outcome = await deps.pair(body);
    sendJson(res, outcome.status, outcome.body);
    return;
  }

  // ── E2E device path: authenticated by possession of the session key ─────────
  const deviceHeader = req.headers['x-marudesk-device'];
  if (typeof deviceHeader === 'string' && deps.devices) {
    const key = await deps.devices.getKey(deviceHeader);
    if (!key) return sendError(res, 401, 'unauthorized');
    deps.devices.touch(deviceHeader);
    return handleAgentRoutes(req, res, deps, pathname, method, e2eCodec(key));
  }

  // ── bearer path (loopback companion / tests) ────────────────────────────────
  const presented = bearerFrom(req);
  if (presented === null || !verifyToken(presented, deps.token)) {
    sendError(res, 401, 'unauthorized');
    return;
  }
  return handleAgentRoutes(req, res, deps, pathname, method, PLAIN_CODEC);
}
