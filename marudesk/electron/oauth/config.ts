import {
  isBuiltinProviderId,
  type BuiltinProviderId,
  type OAuthFlow,
  type ProviderId,
} from '../../shared/providers';

/**
 * OAuth provider configs — docs/oauth-providers-design.md. Each AI provider's
 * OAuth differs in callback strategy (manual-paste vs loopback), token-body
 * encoding, and a few vendor quirks, so the per-provider knobs live here as data
 * and the generic flow (electron/oauth/flow.ts) reads them. Adding a clean
 * OpenAI-compatible OAuth provider is a new config entry + a provider/driver;
 * providers that need a bespoke API dialect (OpenAI Codex, Google Code-Assist)
 * are deliberately out of scope (§7).
 */

export type OAuthProviderConfig = {
  provider: BuiltinProviderId;
  flow: OAuthFlow;
  clientId: string;
  scopes: string;
  authorizeUrl: string;
  /** Token endpoints, tried in order; the first that responds wins. */
  tokenUrls: string[];
  /**
   * A public client_secret sent in the token exchange. Google's "desktop app"
   * OAuth clients require one (it's not actually confidential — shipped in every
   * gemini-cli). Omitted for PKCE-only public clients (Anthropic, xAI, OpenAI).
   */
  clientSecret?: string;
  /** Authorization-code exchange body encoding — Anthropic=json, xAI/Google/OpenAI=form. */
  tokenEncoding: 'json' | 'form';
  /** Refresh body encoding when it differs from {@link tokenEncoding} (OpenAI:
   * exchange is form but refresh is JSON). Defaults to `tokenEncoding`. */
  refreshTokenEncoding?: 'json' | 'form';
  /** manual-paste: the fixed hosted callback URI the page is served at. */
  redirectUri?: string;
  /** loopback: the transient local server target (redirect rebuilt from the bound port). */
  loopback?: {
    host: string;
    port: number;
    path: string;
    /** Extra ports to try (in order) if `port` is busy, before ephemeral/failure. */
    fallbackPorts?: number[];
    /** Allow an ephemeral port when all listed ports are busy (RFC 8252 — most
     * public clients accept any loopback port). Defaults true; OpenAI sets false
     * because its client only allowlists 1455/1457. */
    allowEphemeral?: boolean;
  };
  /** Extra static authorize-query params (Anthropic: code=true; xAI: plan/referrer). */
  authorizeExtras?: Record<string, string>;
  /** Send an OIDC `nonce` on the authorize request (xAI). */
  useNonce?: boolean;
  /** Include `state` in the token-exchange body (Anthropic does; xAI doesn't). */
  sendStateInTokenExchange?: boolean;
  /** Re-echo code_challenge+method in the token-exchange body (xAI workaround #26990). */
  echoChallengeInTokenExchange?: boolean;
  /**
   * Require the callback to carry the CSRF `state` (and match it) on completion.
   * Both providers issue one; a state-less paste is rejected (no verifier-only fallback).
   */
  requireState: boolean;
};

/** Anthropic / Claude Code public client — manual-paste, billed to the subscription. */
export const ANTHROPIC_OAUTH: OAuthProviderConfig = {
  provider: 'anthropic',
  flow: 'manual-paste',
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  scopes: 'org:create_api_key user:profile user:inference',
  authorizeUrl: 'https://claude.ai/oauth/authorize',
  tokenUrls: [
    'https://console.anthropic.com/v1/oauth/token',
    'https://platform.claude.com/v1/oauth/token',
  ],
  tokenEncoding: 'json',
  redirectUri: 'https://console.anthropic.com/oauth/code/callback',
  authorizeExtras: { code: 'true' },
  sendStateInTokenExchange: true,
  requireState: true,
};

/**
 * xAI Grok — standard OIDC auth-code + PKCE against auth.x.ai, captured by a
 * loopback server. Endpoints are from the live discovery doc
 * (auth.x.ai/.well-known/openid-configuration); the access token is then used as
 * a plain Bearer key against the OpenAI-compatible api.x.ai/v1 (no special
 * headers). `plan=generic` is required or non-allowlisted clients are rejected;
 * the token exchange must re-echo the PKCE challenge (xAI issue #26990).
 */
export const XAI_OAUTH: OAuthProviderConfig = {
  provider: 'xai',
  flow: 'loopback',
  clientId: 'b1a00492-073a-47ea-816f-4c329264a828',
  scopes: 'openid profile email offline_access grok-cli:access api:access',
  authorizeUrl: 'https://auth.x.ai/oauth2/authorize',
  tokenUrls: ['https://auth.x.ai/oauth2/token'],
  tokenEncoding: 'form',
  loopback: { host: '127.0.0.1', port: 56121, path: '/callback' },
  authorizeExtras: { plan: 'generic', referrer: 'marudesk' },
  useNonce: true,
  echoChallengeInTokenExchange: true,
  requireState: true,
};

/**
 * OpenAI ChatGPT/Codex — loopback PKCE against auth.openai.com (codex-cli's
 * client). EXPERIMENTAL: the access token only works against the ChatGPT
 * `backend-api/codex` Responses backend (not api.openai.com). Quirks verified from
 * openai/codex source: exchange is form but **refresh is JSON**; the client only
 * allowlists ports 1455/1457 (no ephemeral); `id_token_add_organizations` +
 * `codex_cli_simplified_flow` + `originator` are required authorize params.
 */
export const OPENAI_CODEX_OAUTH: OAuthProviderConfig = {
  provider: 'openai-codex',
  flow: 'loopback',
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  scopes: 'openid profile email offline_access api.connectors.read api.connectors.invoke',
  authorizeUrl: 'https://auth.openai.com/oauth/authorize',
  tokenUrls: ['https://auth.openai.com/oauth/token'],
  tokenEncoding: 'form',
  refreshTokenEncoding: 'json',
  loopback: { host: 'localhost', port: 1455, path: '/auth/callback', fallbackPorts: [1457], allowEphemeral: false },
  authorizeExtras: {
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: 'codex_cli_rs',
  },
  requireState: true,
};

/**
 * Google Gemini on a personal account — loopback PKCE with gemini-cli's public
 * "desktop app" client (+ its public client_secret). EXPERIMENTAL: the token is
 * used against the Code-Assist backend (cloudcode-pa…/v1internal), translated by a
 * custom fetch (electron/oauth/google-code-assist.ts), NOT the public Gemini API.
 * `access_type=offline` + `prompt=consent` force a refresh token.
 */
export const GOOGLE_CAA_OAUTH: OAuthProviderConfig = {
  provider: 'google-caa',
  flow: 'loopback',
  clientId: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
  clientSecret: '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',
  scopes:
    'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile',
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrls: ['https://oauth2.googleapis.com/token'],
  tokenEncoding: 'form',
  loopback: { host: '127.0.0.1', port: 8085, path: '/oauth2callback' },
  authorizeExtras: { access_type: 'offline', prompt: 'consent' },
  requireState: true,
};

const OAUTH_CONFIGS: Partial<Record<BuiltinProviderId, OAuthProviderConfig>> = {
  anthropic: ANTHROPIC_OAUTH,
  xai: XAI_OAUTH,
  'openai-codex': OPENAI_CODEX_OAUTH,
  'google-caa': GOOGLE_CAA_OAUTH,
};

/* ── OpenAI Codex request shaping (experimental ChatGPT backend) ─────────── */

/** The ChatGPT Codex backend base URL — the access token only works here. */
export const OPENAI_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';

/** Headers the codex backend expects (mirrors codex_cli_rs; dodges its Cloudflare 403). */
export function codexHeaders(accountId: string | null): Record<string, string> {
  const h: Record<string, string> = {
    originator: 'codex_cli_rs',
    'user-agent': 'codex_cli_rs/0.0.0 (marudesk)',
  };
  if (accountId) h['chatgpt-account-id'] = accountId;
  return h;
}

/** Resolve a provider to its OAuth config, or null when it has no OAuth support. */
export function oauthConfigFor(provider: ProviderId): OAuthProviderConfig | null {
  return (isBuiltinProviderId(provider) ? OAUTH_CONFIGS[provider] : undefined) ?? null;
}

/** Whether a provider supports the OAuth flow implemented here. */
export function supportsOAuth(provider: ProviderId): boolean {
  return oauthConfigFor(provider) !== null;
}

/* ── Anthropic-specific request shaping (subscription requests 4xx without it) ── */

/** `anthropic-beta` value required on OAuth (subscription) requests. */
export const ANTHROPIC_OAUTH_BETA = 'claude-code-20250219,oauth-2025-04-20';

/** The system-prompt prefix Anthropic requires on OAuth/subscription requests. */
export const CLAUDE_CODE_SYSTEM_PREFIX =
  "You are Claude Code, Anthropic's official CLI for Claude.";

/** Headers sent on Anthropic OAuth model requests, mirroring the first-party CLI. */
export const ANTHROPIC_OAUTH_HEADERS: Record<string, string> = {
  'anthropic-beta': ANTHROPIC_OAUTH_BETA,
  'user-agent': 'claude-cli/1.0.0 (external, cli)',
  'x-app': 'cli',
};

/** A user-agent for OAuth token requests (mirrors a first-party CLI). */
export const OAUTH_TOKEN_USER_AGENT = 'marudesk-oauth/1.0';

/* ── pasted-callback parsing (manual-paste flow) ─────────────────────────── */

/**
 * Parse whatever the user pasted from a hosted callback page into a code +
 * optional state. Accepts the displayed `code#state`, a full callback URL
 * (`…/callback?code=…&state=…`), or a bare code — taking each token only up to
 * the next separator so trailing junk can't leak into the values.
 */
export function parsePastedCode(pasted: string): { code: string; state?: string } {
  const trimmed = pasted.trim();
  if (!trimmed) throw new Error('paste the authorization code first');
  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new Error('could not parse the pasted callback URL');
    }
    const code = url.searchParams.get('code');
    if (!code) throw new Error('the pasted URL has no ?code= parameter');
    return { code, state: url.searchParams.get('state') ?? undefined };
  }
  const hash = trimmed.indexOf('#');
  if (hash >= 0) {
    const code = trimmed.slice(0, hash).trim();
    const state = trimmed.slice(hash + 1).split(/[#&\s]/)[0];
    return { code, state: state.length > 0 ? state : undefined };
  }
  return { code: trimmed.split(/[?#&\s]/)[0] };
}
