import { randomBytes, createHash } from 'node:crypto';
import type { OAuthTokens, ProviderId } from '../../shared/providers';
import { clearProviderOAuth, getProviderOAuth, setProviderOAuth } from '../secrets';
import {
  oauthConfigFor,
  OAUTH_TOKEN_USER_AGENT,
  type OAuthProviderConfig,
} from './config';

/**
 * The generic OAuth flow (PKCE → authorize URL → token exchange/refresh → valid
 * access token), driven by an {@link OAuthProviderConfig}. Provider differences
 * (token-body encoding, extra authorize params, the xAI challenge re-echo) are
 * config flags, not branches here. All of this runs in the main process; tokens
 * are persisted only in the encrypted vault (electron/secrets.ts) and never reach
 * the renderer. See docs/oauth-providers-design.md.
 */

/* ── PKCE + authorize URL ────────────────────────────────────────────────── */

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export type Pkce = { verifier: string; challenge: string; state: string; nonce: string };

/** Fresh PKCE (S256) verifier/challenge + CSRF `state` + OIDC `nonce`. */
export function generatePkce(): Pkce {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = base64url(randomBytes(32));
  const nonce = base64url(randomBytes(16));
  return { verifier, challenge, state, nonce };
}

/**
 * The provider's authorize URL for this PKCE attempt. `redirectUri` is passed in
 * (a manual-paste provider uses its fixed hosted callback; a loopback provider
 * uses the actually-bound `127.0.0.1:<port>` so authorize and token-exchange URIs
 * stay byte-identical).
 */
export function buildAuthorizeUrl(
  cfg: OAuthProviderConfig,
  pkce: Pkce,
  redirectUri: string,
): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    scope: cfg.scopes,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    state: pkce.state,
    ...(cfg.useNonce ? { nonce: pkce.nonce } : {}),
    ...(cfg.authorizeExtras ?? {}),
  });
  return `${cfg.authorizeUrl}?${params.toString()}`;
}

/* ── token exchange / refresh ────────────────────────────────────────────── */

class OAuthHttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'OAuthHttpError';
    this.status = status;
  }
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
};

function tokensFrom(json: TokenResponse, fallbackRefresh?: string): OAuthTokens {
  if (!json.access_token) throw new Error('token endpoint returned no access_token');
  // Refresh-token rotation: keep the new one when present, else reuse the old.
  const refreshToken = json.refresh_token ?? fallbackRefresh;
  if (!refreshToken) throw new Error('token endpoint returned no refresh_token');
  // Assume 1h when the endpoint omits expires_in; the 60s refresh skew + a refresh
  // on the next turn cover a shorter real lifetime, and over-refreshing is harmless.
  const seconds = typeof json.expires_in === 'number' && json.expires_in > 0 ? json.expires_in : 3600;
  return {
    accessToken: json.access_token,
    refreshToken,
    expiresAt: Date.now() + seconds * 1000,
    scope: typeof json.scope === 'string' ? json.scope : undefined,
  };
}

async function postToken(
  cfg: OAuthProviderConfig,
  body: Record<string, string>,
  encoding: 'json' | 'form' = cfg.tokenEncoding,
): Promise<TokenResponse> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'user-agent': OAUTH_TOKEN_USER_AGENT,
    'content-type':
      encoding === 'form' ? 'application/x-www-form-urlencoded' : 'application/json',
  };
  const payload = encoding === 'form' ? new URLSearchParams(body).toString() : JSON.stringify(body);

  let lastErr: Error | null = null;
  for (const url of cfg.tokenUrls) {
    try {
      const resp = await fetch(url, { method: 'POST', headers, body: payload });
      if (!resp.ok) {
        const detail = (await resp.text().catch(() => '')).slice(0, 300);
        lastErr = new OAuthHttpError(
          `OAuth token endpoint returned HTTP ${resp.status}: ${detail}`,
          resp.status,
        );
        // A definitive 4xx won't differ across mirror endpoints — stop.
        if (resp.status >= 400 && resp.status < 500) throw lastErr;
        continue;
      }
      return (await resp.json()) as TokenResponse;
    } catch (err) {
      if (err instanceof OAuthHttpError && err.status >= 400 && err.status < 500) throw err;
      lastErr = err as Error;
    }
  }
  throw lastErr ?? new Error('OAuth token exchange failed');
}

/**
 * Exchange an authorization code for tokens. `redirectUri` MUST equal the one used
 * to build the authorize URL. Per-provider quirks (state in the body, the xAI
 * challenge re-echo) are config-driven.
 */
export async function exchangeCode(
  cfg: OAuthProviderConfig,
  pkce: Pkce,
  code: string,
  receivedState: string | undefined,
  redirectUri: string,
): Promise<OAuthTokens> {
  const body: Record<string, string> = {
    grant_type: 'authorization_code',
    client_id: cfg.clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: pkce.verifier,
  };
  if (cfg.sendStateInTokenExchange) body.state = receivedState ?? pkce.state;
  if (cfg.echoChallengeInTokenExchange) {
    body.code_challenge = pkce.challenge;
    body.code_challenge_method = 'S256';
  }
  if (cfg.clientSecret) body.client_secret = cfg.clientSecret;
  return tokensFrom(await postToken(cfg, body));
}

async function refreshTokens(
  cfg: OAuthProviderConfig,
  refreshToken: string,
): Promise<OAuthTokens> {
  const body: Record<string, string> = {
    grant_type: 'refresh_token',
    client_id: cfg.clientId,
    refresh_token: refreshToken,
  };
  if (cfg.clientSecret) body.client_secret = cfg.clientSecret;
  const json = await postToken(cfg, body, cfg.refreshTokenEncoding ?? cfg.tokenEncoding);
  return tokensFrom(json, refreshToken);
}

/* ── valid-token resolution (refresh + dedup) ────────────────────────────── */

/** Refresh this many ms before the stored expiry, so a turn never starts on a
 * token that lapses mid-request. */
const REFRESH_SKEW_MS = 60_000;

/** One in-flight refresh per provider so concurrent turns share a single round-trip. */
const inflightRefresh = new Map<ProviderId, Promise<OAuthTokens>>();

/**
 * The current access token for a provider, refreshing first if it's at/near
 * expiry. Returns null when no OAuth connection is stored. Throws a friendly
 * error (and clears the dead connection) when the refresh token is rejected, so
 * the agent path can tell the user to reconnect.
 */
export async function getValidAccessToken(provider: ProviderId): Promise<string | null> {
  const cfg = oauthConfigFor(provider);
  if (!cfg) return null;
  const tokens = await getProviderOAuth(provider);
  if (!tokens) return null;
  if (Date.now() < tokens.expiresAt - REFRESH_SKEW_MS) return tokens.accessToken;

  let pending = inflightRefresh.get(provider);
  if (!pending) {
    pending = (async () => {
      // Re-read inside the critical section: a closely-staggered caller may have
      // just refreshed and rotated the refresh token, so reusing the one we read
      // above would fail — return the fresh token instead of refreshing again.
      const current = await getProviderOAuth(provider);
      if (current && Date.now() < current.expiresAt - REFRESH_SKEW_MS) return current;
      const next = await refreshTokens(cfg, (current ?? tokens).refreshToken);
      await setProviderOAuth(provider, next);
      return next;
    })().finally(() => inflightRefresh.delete(provider));
    inflightRefresh.set(provider, pending);
  }

  try {
    return (await pending).accessToken;
  } catch (err) {
    // 400/401 mean the refresh token is dead (revoked / rotated by another client);
    // clear it so the UI flips to "disconnected". (A 403 is xAI tier-gating — the
    // grant is fine — so we surface it but keep the tokens.)
    if (err instanceof OAuthHttpError && (err.status === 400 || err.status === 401)) {
      await clearProviderOAuth(provider).catch(() => {});
      throw new Error(
        `${labelFor(provider)} OAuth session expired — reconnect in Settings → AI Providers.`,
        { cause: err },
      );
    }
    throw err;
  }
}

function labelFor(provider: ProviderId): string {
  if (provider === 'anthropic') return 'Claude';
  if (provider === 'xai') return 'Grok';
  if (provider === 'openai-codex') return 'ChatGPT';
  if (provider === 'google-caa') return 'Gemini';
  return provider;
}
