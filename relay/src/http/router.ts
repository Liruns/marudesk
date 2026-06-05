import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from '../config.ts';
import { toPublicAccount } from '../accounts/store.ts';
import {
  AuthError,
  authenticate,
  login,
  logout,
  refresh,
  signup,
  loginWithOAuthIdentity,
  type AuthDeps,
} from '../auth/service.ts';
import type { RateLimiter } from '../auth/rate-limit.ts';
import { bearerToken } from './auth-header.ts';
import {
  buildAuthorizeUrl,
  consumeState,
  createState,
  exchangeForIdentity,
  type OAuthProvider,
} from '../oauth/providers.ts';

/**
 * Pure, dependency-injected HTTP handler for the relay's auth API. Mirrors the
 * marudesk bridge router conventions (sendJson/sendError, a capped JSON body
 * reader, generic errors). No sockets here — the WS upgrade is handled in
 * ../server.ts; this owns the JSON request/response surface only.
 *
 * Surface:
 *   POST /auth/signup   {email,password}            → {account, ...tokens}
 *   POST /auth/login    {email,password}            → {account, ...tokens}
 *   POST /auth/refresh  {refreshToken}              → {...tokens}
 *   POST /auth/logout   {refreshToken} (Bearer opt) → {ok} (invalidate that session)
 *   GET  /me            (Bearer)                    → {account}
 *   GET  /auth/{google,github}                      → 302 to provider (or 503)
 *   GET  /auth/{google,github}/callback?code&state  → {account, ...tokens} (or 503)
 *   GET  /health                                    → {ok,name} (unauthenticated liveness)
 *
 * Security: bodies are JSON-only + size-capped; auth routes are per-IP
 * rate-limited; login failures are generic (no enumeration); secrets are never
 * echoed/logged; CORS is locked to configured origins (+ localhost for dev).
 */

const MAX_BODY_BYTES = 64 * 1024;

export type RouterDeps = {
  config: Config;
  auth: AuthDeps;
  rateLimiter: RateLimiter;
};

/**
 * Headers on every JSON response: the content type plus two cheap hardening
 * headers — `nosniff` (no MIME sniffing) and `no-referrer` (don't leak the relay
 * URL, which may carry an OAuth `code`/`state`, via the Referer header).
 */
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
} as const;

/** Extra header for token-bearing responses: keep credentials out of any cache. */
const NO_STORE_HEADERS = { 'cache-control': 'no-store' } as const;

const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

/**
 * Resolve an `Origin` against the allowlist (localhost is always allowed for dev,
 * plus any configured `corsOrigins`). Returns the echo-able origin or null.
 * Exported so the WS upgrade path can apply the SAME allowlist (defense-in-depth).
 */
export function allowedOrigin(origin: string | undefined, config: Config): string | null {
  if (!origin) return null;
  if (LOCALHOST_ORIGIN_RE.test(origin)) return origin; // always allow localhost for dev
  return config.corsOrigins.includes(origin) ? origin : null;
}

function corsHeaders(req: IncomingMessage, config: Config): Record<string, string> {
  const origin = allowedOrigin(req.headers.origin, config);
  if (!origin) return {};
  return {
    'access-control-allow-origin': origin,
    'vary': 'Origin',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '600',
  };
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...JSON_HEADERS,
    'content-length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function sendError(
  res: ServerResponse,
  status: number,
  message: string,
  extraHeaders: Record<string, string> = {},
): void {
  sendJson(res, status, { error: message }, extraHeaders);
}

/** Token-bearing JSON response: same as {@link sendJson} but always `cache-control: no-store`. */
function sendJsonNoStore(
  res: ServerResponse,
  status: number,
  body: unknown,
  cors: Record<string, string>,
): void {
  sendJson(res, status, body, { ...cors, ...NO_STORE_HEADERS });
}


/** Client IP for rate-limiting (socket address; we don't trust XFF in dev). */
export function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}

/** Read a capped JSON body; rejects (and responds) on overflow / bad type / bad JSON. */
function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  return new Promise((resolve, reject) => {
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
      if (size > MAX_BODY_BYTES) {
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

/** Map an AuthError code → HTTP status. Messages are already client-safe/generic. */
function statusForAuthError(code: AuthError['code']): number {
  switch (code) {
    case 'invalid-input':
      return 400;
    case 'email-taken':
      return 409;
    case 'invalid-credentials':
    case 'invalid-refresh':
    case 'unauthorized':
      return 401;
    default:
      return 400;
  }
}

/** Enforce per-IP rate limit on the auth endpoints; responds 429 + returns false if limited. */
function rateOk(req: IncomingMessage, res: ServerResponse, deps: RouterDeps, cors: Record<string, string>): boolean {
  if (deps.rateLimiter.take(clientIp(req))) return true;
  sendError(res, 429, 'too many requests', cors);
  return false;
}

const OAUTH_PROVIDERS: readonly OAuthProvider[] = ['google', 'github'];

/** Resolve a `/auth/<provider>` or `/auth/<provider>/callback` path → provider + isCallback. */
function matchOAuthPath(pathname: string): { provider: OAuthProvider; isCallback: boolean } | null {
  for (const provider of OAUTH_PROVIDERS) {
    if (pathname === `/auth/${provider}`) return { provider, isCallback: false };
    if (pathname === `/auth/${provider}/callback`) return { provider, isCallback: true };
  }
  return null;
}

function providerConfig(provider: OAuthProvider, config: Config) {
  return provider === 'google' ? config.google : config.github;
}

/** Handle the two OAuth routes for a provider. */
async function handleOAuth(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RouterDeps,
  url: URL,
  match: { provider: OAuthProvider; isCallback: boolean },
  cors: Record<string, string>,
): Promise<void> {
  if (req.method !== 'GET') return sendError(res, 405, 'method not allowed', cors);
  const cfg = providerConfig(match.provider, deps.config);
  // The 503 path: provider not configured (no client id/secret) — dev runs fine.
  if (!cfg) {
    sendError(res, 503, `OAuth not configured for ${match.provider}`, cors);
    return;
  }

  if (!match.isCallback) {
    if (!rateOk(req, res, deps, cors)) return;
    const state = createState(match.provider);
    res.writeHead(302, { ...cors, location: buildAuthorizeUrl(match.provider, cfg, state) });
    res.end();
    return;
  }

  // Callback: validate state, exchange the code, map to an account, issue tokens.
  if (!rateOk(req, res, deps, cors)) return;
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!consumeState(match.provider, state)) {
    sendError(res, 400, 'invalid oauth state', cors);
    return;
  }
  if (!code) {
    sendError(res, 400, 'missing authorization code', cors);
    return;
  }
  try {
    const identity = await exchangeForIdentity(match.provider, cfg, code);
    const { account, tokens } = await loginWithOAuthIdentity(deps.auth, identity);
    sendJsonNoStore(res, 200, { account, ...tokens }, cors);
  } catch {
    // Don't leak provider/internal error detail to the browser.
    sendError(res, 502, 'oauth exchange failed', cors);
  }
}

/** Route + handle one request. Resolves after the response is written. */
export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RouterDeps,
): Promise<void> {
  const cors = corsHeaders(req, deps.config);

  // CORS preflight: answer before any auth/work.
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://localhost');
  } catch {
    sendError(res, 400, 'bad request', cors);
    return;
  }
  const pathname = url.pathname;
  const method = req.method ?? 'GET';

  // ── Unauthenticated liveness (no token, no secrets). ─────────────────────
  if (pathname === '/health') {
    if (method !== 'GET') return sendError(res, 405, 'method not allowed', cors);
    sendJson(res, 200, { ok: true, name: 'marudesk-relay' }, cors);
    return;
  }

  // ── OAuth web flow (or 503 when not configured). ─────────────────────────
  const oauth = matchOAuthPath(pathname);
  if (oauth) {
    await handleOAuth(req, res, deps, url, oauth, cors);
    return;
  }

  // ── Local auth (rate-limited, JSON body). ────────────────────────────────
  if (
    pathname === '/auth/signup' ||
    pathname === '/auth/login' ||
    pathname === '/auth/refresh' ||
    pathname === '/auth/logout'
  ) {
    if (method !== 'POST') return sendError(res, 405, 'method not allowed', cors);
    if (!rateOk(req, res, deps, cors)) return;
    let body: unknown;
    try {
      body = await readJsonBody(req, res);
    } catch {
      return; // readJsonBody already responded
    }
    try {
      if (pathname === '/auth/signup') {
        const { account, tokens } = await signup(deps.auth, body);
        sendJsonNoStore(res, 201, { account, ...tokens }, cors);
      } else if (pathname === '/auth/login') {
        const { account, tokens } = await login(deps.auth, body);
        sendJsonNoStore(res, 200, { account, ...tokens }, cors);
      } else if (pathname === '/auth/refresh') {
        const { tokens } = await refresh(deps.auth, body);
        sendJsonNoStore(res, 200, { ...tokens }, cors);
      } else {
        // Logout: invalidate the presented session's refresh jti. Generic success.
        await logout(deps.auth, body, bearerToken(req));
        sendJsonNoStore(res, 200, { ok: true }, cors);
      }
    } catch (err) {
      if (err instanceof AuthError) {
        sendError(res, statusForAuthError(err.code), err.message, cors);
      } else {
        sendError(res, 500, 'internal error', cors);
      }
    }
    return;
  }

  // ── Authenticated: the account behind the bearer access token. ───────────
  if (pathname === '/me') {
    if (method !== 'GET') return sendError(res, 405, 'method not allowed', cors);
    const token = bearerToken(req);
    if (!token) return sendError(res, 401, 'unauthorized', cors);
    try {
      const account = await authenticate(deps.auth, token);
      sendJson(res, 200, { account: toPublicAccount(account) }, cors);
    } catch {
      sendError(res, 401, 'unauthorized', cors);
    }
    return;
  }

  sendError(res, 404, 'not found', cors);
}
