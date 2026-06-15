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
  type AgentCommandName,
  type RemoteEvent,
} from '../../shared/remote';
import { dispatchAgentCommand, type AgentApi } from './dispatch';
import { verifyToken } from './token';

/**
 * The pure, dependency-injected request handler for the loopback CLI bridge
 * (docs/chat-cli-tui-design.md §4). Everything it touches arrives via
 * {@link RouterDeps} — the agent loop's functions, the bearer token, and the event
 * subscribe fn — so it is unit-testable headlessly with mocked deps, no Electron
 * (see harness.ts).
 *
 * Every route is gated by the bearer token (`Authorization: Bearer <token>`);
 * request bodies and responses are cleartext JSON. The companion binds to
 * 127.0.0.1 only, so the loopback origin plus the token is the trust boundary.
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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...JSON_HEADERS,
    'content-length': Buffer.byteLength(payload),
  });
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

/* ── response codec ─────────────────────────────────────────────────────────── */

/**
 * Translates request bodies, response results, and SSE frames between the wire and
 * the loop. Only the cleartext identity codec remains (bearer/loopback carries
 * plain JSON); kept as a small seam so the route handlers stay codec-neutral.
 */
type Codec = {
  /** Decode a parsed POST body into the command args. */
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

const REST_COMMANDS: Record<string, AgentCommandName> = {
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
 * The shared agent route table. GET health/snapshot/events + POST command verbs,
 * each dispatched through the SAME shared validator ({@link dispatchAgentCommand})
 * so the REST surface and the loop semantics can't drift.
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
      return sendError(res, 401, 'unauthorized');
    }
    const outcome = await dispatchAgentCommand(deps.agent, cmd, args);
    if (!outcome.ok) return sendError(res, 400, outcome.error);
    return sendResult(res, codec, pathname, outcome.result);
  }

  sendError(res, 404, 'not found');
}

/**
 * Route + handle one request. Resolves once the response has been written. Every
 * route requires the bearer token, authenticated before any work.
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
  const method = req.method ?? 'GET';

  // ── bearer path (loopback companion / tests) ────────────────────────────────
  const presented = bearerFrom(req);
  if (presented === null || !verifyToken(presented, deps.token)) {
    sendError(res, 401, 'unauthorized');
    return;
  }
  return handleAgentRoutes(req, res, deps, url, method, PLAIN_CODEC);
}
