import { randomBytes } from 'node:crypto';
import type { OAuthProviderConfig } from '../config.ts';
import type { AccountMethod } from '../accounts/store.ts';

/**
 * Standard OAuth 2.0 *web* flow for Google and GitHub (Bridge Model B §2). The
 * relay is the OAuth client: it redirects the browser to the provider's authorize
 * URL, then exchanges the returned `code` (at our registered `redirectUri`) for
 * the user's identity. The resulting {@link OAuthIdentity} is handed to
 * `loginWithOAuthIdentity` to map onto an account + issue our own JWT.
 *
 * Dev without OAuth apps: if a provider's client id/secret are unset, its config
 * is null and the HTTP layer returns 503 "OAuth not configured" — nothing here
 * runs and the relay still serves local auth. (design §4 prerequisite)
 *
 * `state` is a random anti-CSRF nonce we mint on /auth/<p> and must see echoed on
 * the callback; it's tracked in-memory with a short TTL.
 */

export type OAuthProvider = Exclude<AccountMethod, 'local'>; // 'google' | 'github'

export type OAuthIdentity = {
  method: OAuthProvider;
  providerSub: string;
  email: string;
  displayName?: string;
};

type Endpoints = { authorize: string; token: string; scope: string };

const ENDPOINTS: Record<OAuthProvider, Endpoints> = {
  google: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
  },
  github: {
    authorize: 'https://github.com/login/oauth/authorize',
    token: 'https://github.com/login/oauth/access_token',
    scope: 'read:user user:email',
  },
};

/** In-memory CSRF-state store with a TTL; not persistent (dev relay, single proc). */
const STATE_TTL_MS = 10 * 60 * 1000;
const pendingStates = new Map<
  string,
  { provider: OAuthProvider; expiresAt: number; handoffPort: number | null }
>();

/**
 * Mint a state nonce. `handoffPort` marks a desktop loopback handoff (the marudesk
 * app listening on `127.0.0.1:<port>`): the callback then redirects the browser to
 * that port with a one-time handoff code instead of returning tokens as JSON.
 */
export function createState(
  provider: OAuthProvider,
  handoffPort: number | null = null,
  now = Date.now(),
): string {
  const state = randomBytes(24).toString('hex');
  pendingStates.set(state, { provider, expiresAt: now + STATE_TTL_MS, handoffPort });
  return state;
}

/** Consume (one-time) a state for `provider`. Returns the entry iff valid + unexpired. */
export function consumeState(
  provider: OAuthProvider,
  state: string | null,
  now = Date.now(),
): { handoffPort: number | null } | null {
  if (!state) return null;
  const entry = pendingStates.get(state);
  if (!entry) return null;
  pendingStates.delete(state);
  if (entry.provider !== provider || entry.expiresAt <= now) return null;
  return { handoffPort: entry.handoffPort };
}

/** Build the provider authorize URL to redirect the browser to. */
export function buildAuthorizeUrl(
  provider: OAuthProvider,
  cfg: OAuthProviderConfig,
  state: string,
): string {
  const ep = ENDPOINTS[provider];
  const url = new URL(ep.authorize);
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', cfg.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', ep.scope);
  url.searchParams.set('state', state);
  if (provider === 'google') {
    url.searchParams.set('access_type', 'online');
    url.searchParams.set('prompt', 'select_account');
  }
  return url.toString();
}

async function exchangeCode(
  provider: OAuthProvider,
  cfg: OAuthProviderConfig,
  code: string,
): Promise<string> {
  const ep = ENDPOINTS[provider];
  const res = await fetch(ep.token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: cfg.redirectUri,
    }).toString(),
  });
  if (!res.ok) throw new Error(`token exchange failed (${res.status})`);
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error('no access_token in token response');
  return json.access_token;
}

async function fetchGoogleIdentity(accessToken: string): Promise<OAuthIdentity> {
  const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`userinfo failed (${res.status})`);
  const u = (await res.json()) as { sub?: string; email?: string; email_verified?: boolean | string; name?: string };
  if (!u.sub || !u.email) throw new Error('google identity missing sub/email');
  // Require a verified email (matches the GitHub primary+verified bar) — linking an
  // account by email on an UNverified address would allow account hijack. Google may
  // serialize this as a boolean or the string "true".
  if (u.email_verified !== true && u.email_verified !== 'true') {
    throw new Error('google identity email is not verified');
  }
  return {
    method: 'google',
    providerSub: u.sub,
    email: u.email,
    ...(u.name ? { displayName: u.name } : {}),
  };
}

async function fetchGithubIdentity(accessToken: string): Promise<OAuthIdentity> {
  const headers = { authorization: `Bearer ${accessToken}`, accept: 'application/vnd.github+json' };
  const userRes = await fetch('https://api.github.com/user', { headers });
  if (!userRes.ok) throw new Error(`github /user failed (${userRes.status})`);
  const user = (await userRes.json()) as { id?: number; login?: string; name?: string; email?: string | null };
  if (user.id === undefined) throw new Error('github identity missing id');

  let email = user.email ?? '';
  if (!email) {
    // GitHub often omits a public email; fetch the verified primary explicitly.
    const emailRes = await fetch('https://api.github.com/user/emails', { headers });
    if (emailRes.ok) {
      const emails = (await emailRes.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
      email = emails.find((e) => e.primary && e.verified)?.email ?? emails.find((e) => e.verified)?.email ?? '';
    }
  }
  if (!email) throw new Error('github identity missing a usable email');
  return {
    method: 'github',
    providerSub: String(user.id),
    email,
    ...(user.name ? { displayName: user.name } : user.login ? { displayName: user.login } : {}),
  };
}

/** Exchange an authorization `code` for a normalized identity. */
export async function exchangeForIdentity(
  provider: OAuthProvider,
  cfg: OAuthProviderConfig,
  code: string,
): Promise<OAuthIdentity> {
  const accessToken = await exchangeCode(provider, cfg, code);
  return provider === 'google'
    ? fetchGoogleIdentity(accessToken)
    : fetchGithubIdentity(accessToken);
}
