import type {
  RelayAccount,
  RelayAuthResponse,
  RelayTokenPair,
} from '../../shared/remote';

/**
 * The PC-side cloud-account HTTP client for the Bridge Model B relay
 * (docs/bridge-model-b-design.md §B2/§2). Thin wrapper over the relay's auth
 * surface (relay/src/http/router.ts): signup / login (email+password for dev) +
 * refresh + logout. Uses the global `fetch` (Node 18+/Electron) — no new
 * dependency. Errors surface the relay's `{error}` message (already client-safe /
 * generic — no user enumeration), and tokens are returned to the caller (main)
 * only; they're persisted by electron/secrets.ts and never reach the renderer.
 *
 * Google/GitHub OAuth is the relay's standard web flow (a browser redirect to
 * `/auth/{google,github}/callback`); wiring that into the desktop app needs the
 * registered OAuth apps + a deep-link/code exchange and is deferred to B4 — the
 * email/password path is fully wired here for local dev.
 */

const AUTH_TIMEOUT_MS = 15_000;

/** Normalize a relay base URL: trim, drop a trailing slash. Throws on an invalid URL. */
export function normalizeRelayUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  // Validate it parses as an http(s) URL so we never build a request against junk.
  const u = new URL(trimmed);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('relay URL must be http(s)');
  }
  return trimmed;
}

/**
 * Derive the WS endpoint from the HTTP relay base URL: `http(s)://host` →
 * `ws(s)://host/connect`. Mirrors the relay's documented `/connect` path.
 */
export function relayConnectUrl(relayUrl: string, role: 'host' | 'client', token: string): string {
  const u = new URL(relayUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/connect';
  u.search = `?role=${role}&token=${encodeURIComponent(token)}`;
  return u.toString();
}

type FetchInit = {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  bearer?: string;
};

/** One JSON request to the relay with a bounded timeout; returns parsed JSON + status. */
async function relayFetch(
  relayUrl: string,
  init: FetchInit,
): Promise<{ status: number; json: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {};
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
    const res = await fetch(`${relayUrl}${init.path}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text.length ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

/** Pull a human-readable error message out of a relay error response. */
function errorMessage(json: unknown, fallback: string): string {
  if (json && typeof json === 'object' && typeof (json as { error?: unknown }).error === 'string') {
    return (json as { error: string }).error;
  }
  return fallback;
}

/** Validate a relay auth response (account + tokens) defensively. */
function coerceAuthResponse(json: unknown): RelayAuthResponse | null {
  if (!json || typeof json !== 'object') return null;
  const j = json as Record<string, unknown>;
  if (typeof j.accessToken !== 'string' || typeof j.refreshToken !== 'string') return null;
  const acc = j.account as Record<string, unknown> | undefined;
  if (!acc || typeof acc !== 'object') return null;
  if (
    typeof acc.id !== 'string' ||
    typeof acc.email !== 'string' ||
    typeof acc.createdAt !== 'string' ||
    (acc.method !== 'local' && acc.method !== 'google' && acc.method !== 'github')
  ) {
    return null;
  }
  const account: RelayAccount = {
    id: acc.id,
    method: acc.method,
    email: acc.email,
    createdAt: acc.createdAt,
    ...(typeof acc.displayName === 'string' ? { displayName: acc.displayName } : {}),
  };
  return {
    account,
    accessToken: j.accessToken,
    refreshToken: j.refreshToken,
    expiresInSec: typeof j.expiresInSec === 'number' ? j.expiresInSec : 0,
  };
}

/** `POST /auth/signup` or `/auth/login` (mode picks the path). */
export async function relayAuthenticate(
  relayUrl: string,
  mode: 'login' | 'signup',
  email: string,
  password: string,
): Promise<RelayAuthResponse> {
  const path = mode === 'signup' ? '/auth/signup' : '/auth/login';
  const { status, json } = await relayFetch(relayUrl, { method: 'POST', path, body: { email, password } });
  const ok = mode === 'signup' ? status === 201 : status === 200;
  if (!ok) throw new Error(errorMessage(json, `relay ${mode} failed (HTTP ${status})`));
  const parsed = coerceAuthResponse(json);
  if (!parsed) throw new Error('relay returned a malformed auth response');
  return parsed;
}

/** `POST /auth/refresh` → a fresh token pair. Throws on a rejected/expired refresh. */
export async function relayRefresh(
  relayUrl: string,
  refreshToken: string,
): Promise<RelayTokenPair> {
  const { status, json } = await relayFetch(relayUrl, {
    method: 'POST',
    path: '/auth/refresh',
    body: { refreshToken },
  });
  if (status !== 200) throw new Error(errorMessage(json, `relay refresh failed (HTTP ${status})`));
  const j = (json ?? {}) as Record<string, unknown>;
  if (typeof j.accessToken !== 'string' || typeof j.refreshToken !== 'string') {
    throw new Error('relay returned a malformed refresh response');
  }
  return {
    accessToken: j.accessToken,
    refreshToken: j.refreshToken,
    expiresInSec: typeof j.expiresInSec === 'number' ? j.expiresInSec : 0,
  };
}

/** `POST /auth/logout` — invalidate the session's refresh token. Best-effort (never throws). */
export async function relayLogout(
  relayUrl: string,
  refreshToken: string,
  accessToken?: string,
): Promise<void> {
  try {
    await relayFetch(relayUrl, {
      method: 'POST',
      path: '/auth/logout',
      body: { refreshToken },
      bearer: accessToken,
    });
  } catch {
    // Logout is best-effort: a dead network/relay still lets us clear local state.
  }
}
