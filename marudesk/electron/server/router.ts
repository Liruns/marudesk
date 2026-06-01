import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AgentChatState } from '../../shared/agent';
import {
  REMOTE_MAX_BODY_BYTES,
  REMOTE_SSE_PING_MS,
  type RelayCommandName,
  type RemoteEvent,
} from '../../shared/remote';
import { dispatchAgentCommand, type AgentApi } from './dispatch';
import { verifyToken } from './token';

/**
 * The pure, dependency-injected request handler for the bridge server
 * (docs/remote-mobile-bridge-design §M4). Everything it touches arrives via
 * {@link RouterDeps} — the agent loop's functions, the bearer token, and the
 * event subscribe fn — so it is unit-testable headlessly with mocked deps, no
 * Electron required (see electron/server/harness.ts).
 *
 * Security posture (the server binds all interfaces for LAN/Tailscale reach but is
 * off by default — see ./index.ts): EVERY route is behind the bearer-token guard,
 * checked BEFORE any work via a constant-time compare. POST bodies must be JSON and
 * are capped.
 * The handler only relays the loop's already-scrubbed state; it never logs the
 * token or echoes request bodies.
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
};

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' } as const;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, message: string): void {
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

/** Format one SSE frame for a relayed event. */
function sseFrame(event: RemoteEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function handleSse(req: IncomingMessage, res: ServerResponse, deps: RouterDeps): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // We never relay to a different origin; deny CORS explicitly rather than
    // leaving it ambiguous (M4 is same-process companion only).
    'x-accel-buffering': 'no',
  });
  // First frame: the current snapshot, so a fresh client renders immediately
  // without a separate /agent/snapshot round-trip.
  res.write(sseFrame({ type: 'snapshot', state: deps.agent.snapshot() }));

  // Relay every subsequent state the loop emits.
  const unsubscribe = deps.subscribe((state) => {
    // Honor backpressure: if the socket buffer is already backed up (a stalled or
    // slow client), skip this frame instead of queuing another full snapshot — the
    // next emit carries the latest state anyway. Stops a stuck client from growing
    // main-process memory unbounded (security review M-1).
    if (res.writableNeedDrain) return;
    res.write(sseFrame({ type: 'snapshot', state }));
  });

  // Keep-alive comments so intermediaries (and the client) hold the connection.
  const ping = setInterval(() => res.write(': ping\n\n'), REMOTE_SSE_PING_MS);
  if (typeof ping.unref === 'function') ping.unref();

  const cleanup = (): void => {
    clearInterval(ping);
    unsubscribe();
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
}

/**
 * Route + handle one request. Resolves once the response has been written.
 * The bearer-token guard runs first for every route (no anonymous probe).
 */
export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RouterDeps,
): Promise<void> {
  // ── auth: reject missing/wrong token BEFORE doing anything else ──────────
  const presented = bearerFrom(req);
  if (presented === null || !verifyToken(presented, deps.token)) {
    sendError(res, 401, 'unauthorized');
    return;
  }

  let pathname: string;
  try {
    pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  } catch {
    sendError(res, 400, 'bad request');
    return;
  }
  const method = req.method ?? 'GET';

  // ── GET routes ───────────────────────────────────────────────────────────
  if (pathname === '/health') {
    if (method !== 'GET') return sendError(res, 405, 'method not allowed');
    sendJson(res, 200, { ok: true, name: 'marudesk', version: deps.version });
    return;
  }
  if (pathname === '/agent/snapshot') {
    if (method !== 'GET') return sendError(res, 405, 'method not allowed');
    sendJson(res, 200, deps.agent.snapshot());
    return;
  }
  if (pathname === '/agent/events') {
    if (method !== 'GET') return sendError(res, 405, 'method not allowed');
    handleSse(req, res, deps);
    return;
  }

  // ── POST routes ──────────────────────────────────────────────────────────
  // Each maps to a relay command verb dispatched through the SHARED dispatcher
  // (./dispatch.ts) — the same validate(parse.ts)→loop path the Bridge Model B
  // relay-client uses, so REST and relay can't drift. `reset` takes no body.
  const REST_COMMANDS: Record<string, RelayCommandName> = {
    '/agent/send': 'send',
    '/agent/abort': 'abort',
    '/agent/respond': 'respond',
    '/agent/approve': 'approve',
    '/agent/reset': 'reset',
  };
  const cmd = REST_COMMANDS[pathname];
  if (cmd) {
    if (method !== 'POST') return sendError(res, 405, 'method not allowed');
    let body: unknown;
    try {
      body = await readJsonBody(req, res);
    } catch {
      return; // readJsonBody already wrote the 4xx response
    }
    const outcome = await dispatchAgentCommand(deps.agent, cmd, body);
    // A validation failure (bad command args) is a 400, mirroring the prior
    // per-route parse-error handling; a successful dispatch returns its result.
    if (!outcome.ok) {
      sendError(res, 400, outcome.error);
      return;
    }
    sendJson(res, 200, outcome.result);
    return;
  }

  sendError(res, 404, 'not found');
}
