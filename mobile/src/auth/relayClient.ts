import type { RelayAccount, RelayAuthResponse, RelayTokenPair } from '../types';

/**
 * Typed fetch wrapper for the relay's auth REST surface (relay/src/http/router.ts).
 * Pure transport — no React, no storage. The store decides what to persist.
 *
 *   POST /auth/signup  {email,password}  → 201 RelayAuthResponse
 *   POST /auth/login   {email,password}  → 200 RelayAuthResponse
 *   POST /auth/refresh {refreshToken}    → 200 RelayTokenPair
 *   POST /auth/logout  {refreshToken}    → 200 {ok}
 *   GET  /me           (Bearer)          → 200 {account}
 *   GET  /auth/{google,github}           → 302 (browser flow) or 503
 *   GET  /health                         → 200 {ok,name}
 */

/** A normalized error the UI can show without leaking transport detail. */
export class RelayApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'RelayApiError';
  }
}

/** Trim a trailing slash so we can append `/auth/...` cleanly. */
export function normalizeRelayUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

async function parseJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new RelayApiError('Malformed response from relay', res.status);
  }
}

function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && 'error' in body) {
    const e = (body as { error: unknown }).error;
    if (typeof e === 'string' && e.length > 0) return e;
  }
  return fallback;
}

async function postJson(base: string, path: string, body: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new RelayApiError('Could not reach the relay. Check the URL and network.', 0);
  }
  const json = await parseJson(res);
  if (!res.ok) throw new RelayApiError(errorMessage(json, `Request failed (${res.status})`), res.status);
  return json;
}

export async function signup(base: string, email: string, password: string): Promise<RelayAuthResponse> {
  return (await postJson(base, '/auth/signup', { email, password })) as RelayAuthResponse;
}

export async function login(base: string, email: string, password: string): Promise<RelayAuthResponse> {
  return (await postJson(base, '/auth/login', { email, password })) as RelayAuthResponse;
}

export async function refresh(base: string, refreshToken: string): Promise<RelayTokenPair> {
  return (await postJson(base, '/auth/refresh', { refreshToken })) as RelayTokenPair;
}

export async function logout(base: string, refreshToken: string, accessToken?: string): Promise<void> {
  try {
    await fetch(`${base}/auth/logout`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify({ refreshToken }),
    });
  } catch {
    // Best-effort: a failed server-side logout still clears local tokens.
  }
}

export async function me(base: string, accessToken: string): Promise<RelayAccount> {
  let res: Response;
  try {
    res = await fetch(`${base}/me`, { headers: { authorization: `Bearer ${accessToken}` } });
  } catch {
    throw new RelayApiError('Could not reach the relay.', 0);
  }
  const json = await parseJson(res);
  if (!res.ok) throw new RelayApiError(errorMessage(json, 'Unauthorized'), res.status);
  return (json as { account: RelayAccount }).account;
}

export async function health(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

/** The browser URL that starts a provider OAuth flow (server 302s to the provider). */
export function oauthStartUrl(base: string, provider: 'google' | 'github'): string {
  return `${base}/auth/${provider}`;
}
