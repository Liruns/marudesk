import { isProviderId, type OAuthFlow, type ProviderId } from '../../shared/providers';
import { defineHandler } from '../ipc/define-handler';
import { obj, optStr } from '../ipc/validate';
import { invalidateModelsCache } from '../models';
import { clearProviderOAuth, setProviderOAuth, getAllProviderOAuth, rotateProviderOAuth } from '../secrets';
import { openExternalUrl } from '../safe-open';
import { oauthConfigFor, parsePastedCode, supportsOAuth, type OAuthProviderConfig } from './config';
import { buildAuthorizeUrl, exchangeCode, generatePkce, type Pkce } from './flow';
import { requestDeviceCode, pollForToken, type DeviceCodeResponse } from './device-flow';
import { startLoopbackServer, type LoopbackServer } from './loopback';
import { clearCodeAssistProject } from './google-code-assist';

/**
 * IPC for OAuth subscription/account login (docs/oauth-providers-design.md §5.2),
 * generalized over two callback strategies:
 *   - manual-paste (Anthropic): `start` returns the authorize URL; the user pastes
 *     the `code#state` the hosted callback page shows; `complete` exchanges it.
 *   - loopback (xAI): `start` also spins up a transient 127.0.0.1 server; `complete`
 *     awaits that server's callback (so its `pasted` arg is unused), then exchanges.
 * The short-lived PKCE secret + the loopback server live in main-process memory
 * between start and complete — never persisted, never sent to the renderer. A TTL
 * bounds an abandoned attempt; `cancel` tears down a pending loopback wait.
 */

const PENDING_TTL_MS = 10 * 60 * 1000;
/** How long a loopback `complete` waits for the user to finish in the browser. */
const LOOPBACK_TIMEOUT_MS = 3 * 60 * 1000;

type Pending = {
  cfg: OAuthProviderConfig;
  pkce: Pkce;
  createdAt: number;
  redirectUri: string;
  /** loopback only. */
  server?: LoopbackServer;
  abort?: AbortController;
  /** device-code only. */
  deviceCode?: DeviceCodeResponse;
};
const pending = new Map<ProviderId, Pending>();

function requireOAuthProvider(value: unknown): ProviderId {
  if (!isProviderId(value)) throw new Error('invalid provider');
  if (!supportsOAuth(value)) throw new Error(`${value} does not support OAuth login`);
  return value;
}

/** Tear down (and forget) any in-flight attempt for a provider. */
function discardPending(provider: ProviderId): void {
  const entry = pending.get(provider);
  if (!entry) return;
  entry.abort?.abort();
  entry.server?.close();
  pending.delete(provider);
}

/** Begin a flow: fresh PKCE, (loopback) a local server, open the browser, return the URL + flow. */
async function startOAuth(
  provider: ProviderId,
): Promise<{ flow: OAuthFlow; url: string; opened: boolean; userCode?: string; verificationUri?: string }> {
  const cfg = oauthConfigFor(provider);
  if (!cfg) throw new Error(`${provider} does not support OAuth login`);
  discardPending(provider); // a new attempt supersedes any abandoned one

  const pkce = generatePkce();
  let redirectUri: string;
  const entry: Pending = { cfg, pkce, createdAt: Date.now(), redirectUri: '' };

  if (cfg.flow === 'device-code') {
    // Device Authorization Grant (RFC 8628): request a device code, then the
    // user visits a verification URL and enters a short user code. The main
    // process polls for token grant in `completeOAuth`.
    const dcResponse = await requestDeviceCode({
      provider: cfg.provider,
      clientId: cfg.clientId,
      scopes: cfg.scopes,
      deviceAuthUrl: cfg.authorizeUrl,
      tokenUrl: cfg.tokenUrls[0],
    });
    entry.deviceCode = dcResponse;
    entry.abort = new AbortController();
    redirectUri = '';
    entry.redirectUri = redirectUri;
    pending.set(provider, entry);
    const verificationUrl = dcResponse.verificationUriComplete ?? dcResponse.verificationUri;
    const opened = await openExternalUrl(verificationUrl);
    return {
      flow: 'device-code',
      url: verificationUrl,
      opened,
      userCode: dcResponse.userCode,
      verificationUri: dcResponse.verificationUri,
    };
  } else if (cfg.flow === 'loopback') {
    if (!cfg.loopback) throw new Error(`${provider} loopback config missing`);
    const server = await startLoopbackServer({
      host: cfg.loopback.host,
      ports: [cfg.loopback.port, ...(cfg.loopback.fallbackPorts ?? [])],
      allowEphemeral: cfg.loopback.allowEphemeral ?? true,
      path: cfg.loopback.path,
    });
    redirectUri = server.redirectUri;
    entry.server = server;
    entry.abort = new AbortController();
  } else {
    if (!cfg.redirectUri) throw new Error(`${provider} redirect URI missing`);
    redirectUri = cfg.redirectUri;
  }

  entry.redirectUri = redirectUri;
  pending.set(provider, entry);

  const url = buildAuthorizeUrl(cfg, pkce, redirectUri);
  // The renderer also gets the URL as a fallback link; `opened: false` (a broken
  // default-browser handoff) tells it to lead with that link + copy affordances
  // instead of failing silently — the "Connect did nothing" trap.
  const opened = await openExternalUrl(url);
  return { flow: cfg.flow, url, opened };
}

/** Finish a flow: get the code (paste or loopback callback), validate state, exchange, store. */
async function completeOAuth(provider: ProviderId, pasted: string | undefined): Promise<boolean> {
  const cfg = oauthConfigFor(provider);
  if (!cfg) throw new Error(`${provider} does not support OAuth login`);
  const entry = pending.get(provider);
  if (!entry || Date.now() - entry.createdAt > PENDING_TTL_MS) {
    discardPending(provider);
    throw new Error('the login attempt expired — start "Connect" again');
  }

  try {
    let tokens;
    if (entry.deviceCode && entry.abort) {
      // Device-code flow: poll the token endpoint until the user authorizes.
      if (pending.get(provider) !== entry) throw new Error('superseded by a newer login attempt');
      tokens = await pollForToken(
        {
          provider: cfg.provider,
          clientId: cfg.clientId,
          scopes: cfg.scopes,
          deviceAuthUrl: cfg.authorizeUrl,
          tokenUrl: cfg.tokenUrls[0],
        },
        entry.deviceCode.deviceCode,
        entry.deviceCode.interval,
        entry.deviceCode.expiresIn,
        entry.abort.signal,
      );
    } else {
      let code: string;
      let state: string | undefined;
      if (entry.server && entry.abort) {
        // Loopback: block until the browser hits 127.0.0.1 (or timeout / cancel).
        const r = await entry.server.waitForCallback(LOOPBACK_TIMEOUT_MS, entry.abort.signal);
        code = r.code;
        state = r.state;
      } else {
        ({ code, state } = parsePastedCode(pasted ?? ''));
      }

      // CSRF: state must be present (when the provider issues one) and match.
      if (cfg.requireState && state === undefined) {
        throw new Error('paste the full "code#state" shown on the page — the state is required');
      }
      if (state !== undefined && state !== entry.pkce.state) {
        throw new Error('state mismatch — aborting for safety; start the flow again');
      }

      // A superseding startOAuth (a fresh attempt) would have replaced this entry in
      // the map and aborted our signal; if we still got here, confirm we're the
      // active attempt before persisting so we never clobber a newer one's tokens.
      if (pending.get(provider) !== entry) throw new Error('superseded by a newer login attempt');
      tokens = await exchangeCode(cfg, entry.pkce, code, state, entry.redirectUri);
    }
    await setProviderOAuth(provider, tokens);
    // A fresh google-caa account must re-bootstrap its Code-Assist project.
    if (provider === 'google-caa') clearCodeAssistProject();
    invalidateModelsCache(provider);
    return true;
  } finally {
    entry.server?.close();
    // Only clear the slot if it's still ours — a newer attempt may now own it.
    if (pending.get(provider) === entry) pending.delete(provider);
  }
}

function cancelOAuth(provider: ProviderId): boolean {
  discardPending(provider);
  return true;
}

async function disconnectOAuth(provider: ProviderId): Promise<boolean> {
  discardPending(provider);
  await clearProviderOAuth(provider);
  if (provider === 'google-caa') clearCodeAssistProject();
  invalidateModelsCache(provider);
  return true;
}

export function registerOAuthHandlers(): void {
  defineHandler('auth:oauth-start', ([provider]) => startOAuth(requireOAuthProvider(provider)));

  defineHandler('auth:oauth-complete', ([payload]) => {
    const o = obj(payload);
    const provider = requireOAuthProvider(o.provider);
    return completeOAuth(provider, optStr(o.pasted, 'pasted'));
  });

  defineHandler('auth:oauth-cancel', ([provider]) => cancelOAuth(requireOAuthProvider(provider)));

  defineHandler('auth:oauth-disconnect', ([provider]) =>
    disconnectOAuth(requireOAuthProvider(provider)),
  );

  defineHandler('auth:oauth-slots', async ([provider]) => {
    const id = requireOAuthProvider(provider);
    const slots = await getAllProviderOAuth(id);
    return {
      count: slots.length,
      activeScope: slots[0]?.scope ?? undefined,
    };
  });

  defineHandler('auth:oauth-add-slot', ([provider]) => startOAuth(requireOAuthProvider(provider)));

  defineHandler('auth:oauth-rotate', async ([provider]) => {
    const id = requireOAuthProvider(provider);
    const next = await rotateProviderOAuth(id);
    if (next) invalidateModelsCache(id);
    return !!next;
  });
}
