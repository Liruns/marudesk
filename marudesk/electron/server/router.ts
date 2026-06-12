import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AgentChatState } from '../../shared/agent';
import type { SessionSummary } from '../../shared/context';
import {
  REMOTE_MAX_BODY_BYTES,
  REMOTE_SSE_PING_MS,
  type BridgeCatalogResult,
  type BridgeModelsResult,
  type BridgeSessionDetail,
  type BridgeWorkspacesResult,
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
import { dispatchAgentCommand, type AgentApi, type ApprovalGuard } from './dispatch';
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
  /**
   * Subscribe to one workspace's active-thread state stream (the same pushes the
   * renderer gets on `agent:workspace-event`), for an SSE client that selected a
   * PC workspace via `GET /agent/events?workspace=<id>`. Omit ⇒ that query is
   * rejected (e.g. a harness that only mocks the global stream).
   */
  subscribeWorkspace?(workspaceId: string, cb: (state: AgentChatState) => void): () => void;
  /** T2 E2E: resolve a paired device's key + note activity. Omit ⇒ the E2E path is off. */
  devices?: DeviceResolver;
  /** T2 E2E: handle `POST /pair`. Omit ⇒ `/pair` returns 404 (pairing disabled). */
  pair?: (body: unknown) => Promise<PairOutcome>;
  /**
   * T2 L-1: refuse a remote self-approval of a gated tool while the server is
   * exposed, keeping gated approvals pinned to the desktop UI
   * (docs/t2-secure-pairing-design.md §8). Omit ⇒ no restriction (e.g. the
   * loopback-only dev/test harness).
   */
  approvalGuard?: ApprovalGuard;
  /**
   * Read-mostly catalog routes for thin clients (chat CLI v2 —
   * docs/chat-cli-tui-design.md §4): `GET /agent/models`, `GET /agent/sessions`,
   * `POST /agent/resume-session`. Omit ⇒ those routes 404.
   */
  extras?: RouterExtras;
  /**
   * M-1+ (design §10.1): cap on concurrent SSE streams per server — each one
   * holds a socket + a loop subscription, so an exposed port must not accept
   * them unboundedly. Omit ⇒ {@link DEFAULT_MAX_SSE_CLIENTS}.
   */
  maxSseClients?: number;
};

/** The injected backends for the catalog routes — mockable in harnesses. */
export type RouterExtras = {
  /** Provider catalog + connection state for the `/model` picker. */
  models(): Promise<BridgeModelsResult>;
  /**
   * Saved-session summaries for the `/sessions` picker. `workspaceId` filters to
   * one workspace, `null` to the global (workspace-less) sessions, and
   * `undefined` returns every session (the CLI's cross-workspace list).
   */
  sessions(workspaceId?: string | null): Promise<SessionSummary[]>;
  /**
   * Resume a saved session into the active conversation (next SSE snapshot
   * carries it). `workspaceId` resumes into that workspace's active thread;
   * omitted ⇒ the global thread. The loop still refuses a cross-workspace match.
   */
  resumeSession(id: string, workspaceId?: string): Promise<boolean>;
  /** The PC's open workspaces + the active one, for the workspace picker. */
  workspaces(): Promise<BridgeWorkspacesResult>;
  /** Read a single session's transcript for the CLI `/history` command. */
  readSession(id: string): Promise<BridgeSessionDetail | null>;
  /**
   * The agent-role + skill catalog for the CLI `/agents` and `/skills`
   * commands. `workspaceId` scopes the project definitions; omitted ⇒ the
   * built-in + user scopes only.
   */
  catalog(workspaceId?: string): Promise<BridgeCatalogResult>;
};

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' } as const;

/**
 * CORS for the mobile client: a Capacitor WebView (origin capacitor://localhost or
 * http://localhost) fetching the PC over the LAN is cross-origin, so without these
 * the browser blocks the response. `*` is safe here — every route is still gated by
 * the bearer token or a valid E2E envelope (no cookies/ambient credentials), so a
 * permissive origin grants no access on its own. (A Host-header allowlist for
 * DNS-rebinding — design §10.1 L-2 — remains a separate follow-up.)
 */
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, x-marudesk-device',
  'access-control-max-age': '600',
} as const;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...JSON_HEADERS,
    ...CORS_HEADERS,
    'content-length': Buffer.byteLength(payload),
  });
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

/** Default for {@link RouterDeps.maxSseClients}: a phone + a CLI + headroom. */
const DEFAULT_MAX_SSE_CLIENTS = 8;

/** Live SSE stream count per router instance (keyed by its deps object). */
const sseClientCounts = new WeakMap<RouterDeps, { n: number }>();

/**
 * Stream agent:event snapshots as SSE, encoded per `frame`. Writes are serialized
 * through a tail promise so async (E2E) sealing can't reorder frames, and shed
 * under socket backpressure so a stalled client can't grow main-process memory.
 * Concurrent streams are capped (M-1+) — past the cap a connect gets a 503.
 */
function handleSse(
  req: IncomingMessage,
  res: ServerResponse,
  frame: (event: RemoteEvent) => Promise<string>,
  deps: RouterDeps,
  workspaceId?: string,
): void {
  let count = sseClientCounts.get(deps);
  if (!count) {
    count = { n: 0 };
    sseClientCounts.set(deps, count);
  }
  if (count.n >= (deps.maxSseClients ?? DEFAULT_MAX_SSE_CLIENTS)) {
    sendError(res, 503, 'too many event streams — close another client first');
    return;
  }
  count.n += 1;

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    ...CORS_HEADERS,
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

  // First frame: the current snapshot (workspace-scoped when the client picked a
  // workspace), so a fresh client renders immediately.
  push({ type: 'snapshot', state: deps.agent.snapshot(workspaceId) });
  const unsubscribe =
    workspaceId && deps.subscribeWorkspace
      ? deps.subscribeWorkspace(workspaceId, (state) => push({ type: 'snapshot', state }))
      : deps.subscribe((state) => push({ type: 'snapshot', state }));

  const ping = setInterval(() => res.write(': ping\n\n'), REMOTE_SSE_PING_MS);
  if (typeof ping.unref === 'function') ping.unref();

  let done = false;
  const cleanup = (): void => {
    if (done) return;
    done = true;
    count.n -= 1;
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
  '/agent/edit-plan-step': 'edit-plan-step',
  '/agent/set-approval-mode': 'set-approval-mode',
  '/agent/set-reasoning-effort': 'set-reasoning-effort',
  '/agent/revert-edit': 'revert-edit',
};

/**
 * The `?workspace=` scope on the GET routes: a workspace id, or undefined when
 * absent/empty (the global thread / the route's default breadth). The E2E
 * envelope AADs bind to the PATH only, so a query param never breaks them.
 */
function workspaceParamOf(url: URL): string | undefined {
  const value = url.searchParams.get('workspace');
  return value ? value : undefined;
}

/**
 * The shared agent route table, reached by both auth paths with the matching
 * {@link Codec}. GET health/snapshot/events + POST command verbs (dispatched
 * through the SAME validator the relay uses, so REST and relay can't drift).
 */
async function handleAgentRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RouterDeps,
  url: URL,
  method: string,
  codec: Codec,
): Promise<void> {
  const pathname = url.pathname;
  if (pathname === '/health') {
    if (method !== 'GET') return sendError(res, 405, 'method not allowed');
    return sendResult(res, codec, pathname, { ok: true, name: 'marudesk', version: deps.version });
  }
  if (pathname === '/agent/snapshot') {
    if (method !== 'GET') return sendError(res, 405, 'method not allowed');
    return sendResult(res, codec, pathname, deps.agent.snapshot(workspaceParamOf(url)));
  }
  if (pathname === '/agent/events') {
    if (method !== 'GET') return sendError(res, 405, 'method not allowed');
    const workspaceId = workspaceParamOf(url);
    if (workspaceId && !deps.subscribeWorkspace) {
      return sendError(res, 400, 'workspace-scoped events unsupported');
    }
    handleSse(req, res, codec.sse, deps, workspaceId);
    return;
  }

  // ── catalog routes (chat CLI v2) — only when the extras dep is provided ──
  if (pathname === '/agent/models') {
    if (method !== 'GET') return sendError(res, 405, 'method not allowed');
    if (!deps.extras) return sendError(res, 404, 'not found');
    return sendResult(res, codec, pathname, await deps.extras.models());
  }
  if (pathname === '/agent/workspaces') {
    if (method !== 'GET') return sendError(res, 405, 'method not allowed');
    if (!deps.extras) return sendError(res, 404, 'not found');
    return sendResult(res, codec, pathname, await deps.extras.workspaces());
  }
  if (pathname === '/agent/catalog') {
    if (method !== 'GET') return sendError(res, 405, 'method not allowed');
    if (!deps.extras) return sendError(res, 404, 'not found');
    return sendResult(res, codec, pathname, await deps.extras.catalog(workspaceParamOf(url)));
  }
  if (pathname === '/agent/sessions') {
    if (method !== 'GET') return sendError(res, 405, 'method not allowed');
    if (!deps.extras) return sendError(res, 404, 'not found');
    // `?workspace=<id>` → that workspace's sessions; `?workspace=` (present but
    // empty) → the global, workspace-less sessions; absent → every session (the
    // CLI's cross-workspace list, unchanged).
    const raw = url.searchParams.get('workspace');
    const filter = raw === null ? undefined : raw === '' ? null : raw;
    return sendResult(res, codec, pathname, await deps.extras.sessions(filter));
  }
  if (pathname === '/agent/session') {
    if (method !== 'GET') return sendError(res, 405, 'method not allowed');
    if (!deps.extras) return sendError(res, 404, 'not found');
    const id = url.searchParams.get('id');
    if (!id) return sendError(res, 400, 'id required');
    const detail = await deps.extras.readSession(id);
    if (!detail) return sendError(res, 404, 'session not found');
    return sendResult(res, codec, pathname, detail);
  }
  if (pathname === '/agent/resume-session') {
    if (method !== 'POST') return sendError(res, 405, 'method not allowed');
    if (!deps.extras) return sendError(res, 404, 'not found');
    let raw: unknown;
    try {
      raw = await readJsonBody(req, res);
    } catch {
      return; // readJsonBody already wrote the 4xx response
    }
    let body: unknown;
    try {
      body = await codec.decodeBody(raw, method, pathname);
    } catch {
      return sendError(res, 401, 'unauthorized');
    }
    const id = (body as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || id.length === 0) {
      return sendError(res, 400, 'id required');
    }
    const workspaceRaw = (body as { workspaceId?: unknown }).workspaceId;
    if (workspaceRaw !== undefined && typeof workspaceRaw !== 'string') {
      return sendError(res, 400, 'workspaceId must be a string');
    }
    const workspaceId = workspaceRaw ? workspaceRaw : undefined;
    return sendResult(res, codec, pathname, { ok: await deps.extras.resumeSession(id, workspaceId) });
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
    const outcome = await dispatchAgentCommand(deps.agent, cmd, args, deps.approvalGuard);
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
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://127.0.0.1');
  } catch {
    sendError(res, 400, 'bad request');
    return;
  }
  const pathname = url.pathname;
  const method = req.method ?? 'GET';

  // ── CORS preflight (the mobile WebView sends OPTIONS before a cross-origin
  //    POST with the X-Marudesk-Device / content-type headers) ─────────────────
  if (method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

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
    return handleAgentRoutes(req, res, deps, url, method, e2eCodec(key));
  }

  // ── bearer path (loopback companion / tests) ────────────────────────────────
  const presented = bearerFrom(req);
  if (presented === null || !verifyToken(presented, deps.token)) {
    sendError(res, 401, 'unauthorized');
    return;
  }
  return handleAgentRoutes(req, res, deps, url, method, PLAIN_CODEC);
}
