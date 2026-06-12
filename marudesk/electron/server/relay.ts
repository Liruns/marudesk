import type { AppSettings } from '../../shared/settings';
import type { RelayStatus } from '../../shared/remote';
import { subscribeAgentEvents } from '../agent/loop';
import {
  clearRelaySession,
  getRelaySession,
  setRelaySession,
  updateRelayTokens,
  type RelaySession,
} from '../secrets';
import { defineHandler } from '../ipc/define-handler';
import { enumOf, nonEmptyStr, obj, str } from '../ipc/validate';
import { startLoopbackServer } from '../oauth/loopback';
import { setActiveProfileAccount } from '../profile-store';
import { openExternalUrl } from '../safe-open';
import { getSettingsSync } from '../settings';
import { createApprovalGuard } from './approval-guard';
import { LOOP_AGENT_API } from './loop-api';
import { projectRemoteCallback } from './remote-state';
import {
  normalizeRelayUrl,
  relayAuthenticate,
  relayGoogleAuthorizeUrl,
  relayHandoffExchange,
  relayLogout,
} from './relay-auth';
import { startRelayClient, type RelayClient } from './relay-client';

/**
 * Lifecycle for the Bridge Model B cloud-relay host (docs/bridge-model-b-design.md
 * §B2). Owns the singleton outbound {@link RelayClient}, the stored cloud session,
 * and the auto-connect rule: the PC holds an outbound host WS to the relay exactly
 * when the user is logged in AND `settings.server.cloudEnabled` is on.
 *
 * The agent loop's functions are called DIRECTLY (no IPC), same as the M4 bridge
 * server; the relay-client mediates them through the shared dispatcher. A sanitized
 * `{ account, connected }` status is pushed to the renderer (never the tokens).
 *
 * Nothing here ever crashes main: auth errors propagate to the IPC caller as a
 * message, and connection errors are swallowed by the relay-client's reconnect.
 */

// One shared loop binding for every bridge transport — workspace-scoped
// reset/snapshot and the reasoning-effort setter included (see loop-api.ts).
const AGENT = LOOP_AGENT_API;

let client: RelayClient | null = null;
/** The relay URL the live client was started against (so a URL change reconnects). */
let clientRelayUrl: string | null = null;
/** Whether cloud was enabled at last reconcile (so an enable/disable flip reconnects). */
let lastEnabled = false;
let onStatus: ((status: RelayStatus) => void) | null = null;

/** Wire the renderer status-push once (from main.ts). Replays nothing — pull on demand. */
export function setRelayStatusListener(fn: (status: RelayStatus) => void): void {
  onStatus = fn;
}

function pushStatus(): void {
  // Fire-and-forget: compute the sanitized status and notify the renderer.
  void getStatus().then((status) => onStatus?.(status));
}

/** The sanitized status the renderer may see — account (or null) + connected flag. */
export async function getStatus(): Promise<RelayStatus> {
  const session = await getRelaySession();
  return {
    account: session?.account ?? null,
    connected: client?.isConnected() ?? false,
  };
}

function stopClient(): void {
  if (client) {
    client.stop();
    client = null;
    clientRelayUrl = null;
  }
}

/** Start the outbound host for a stored session (no-op if already on the same URL). */
function startClient(session: RelaySession): void {
  if (client && clientRelayUrl === session.relayUrl) return;
  stopClient();
  clientRelayUrl = session.relayUrl;
  client = startRelayClient({
    relayUrl: session.relayUrl,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    agent: AGENT,
    // Remote-projected like the M4 server's stream (bounded editDiffs view).
    subscribe: (cb) => subscribeAgentEvents(projectRemoteCallback(cb)),
    // T2 L-1: same desktop-pinned gated-approval guard as the M4 server, so the
    // cloud path can't be used for remote self-approval either.
    approvalGuard: createApprovalGuard(),
    onTokens: (accessToken, refreshToken) => {
      // Persist rotated tokens so a restart resumes the session without re-login.
      void updateRelayTokens(accessToken, refreshToken);
    },
    onConnectedChange: () => pushStatus(),
  });
}

/**
 * Reconcile the live client with settings + the stored session: connect when
 * logged in AND cloud is enabled (and not already connected on the right URL),
 * disconnect otherwise. Safe to call at startup and on every settings change.
 */
export async function syncRelayToSettings(settings: AppSettings): Promise<void> {
  const enabled = settings.server.cloudEnabled;
  lastEnabled = enabled;
  const session = enabled ? await getRelaySession() : null;
  if (!enabled || !session) {
    stopClient();
    return;
  }
  startClient(session);
}

/**
 * Log in (or sign up) to the relay with email+password, persist the session, and
 * (if cloud is enabled) connect as host. Returns the sanitized status. Throws the
 * relay's error message on failure (already generic — no enumeration).
 */
export async function login(input: {
  relayUrl: string;
  email: string;
  password: string;
  mode: 'login' | 'signup';
  cloudEnabled: boolean;
}): Promise<RelayStatus> {
  const relayUrl = normalizeRelayUrl(input.relayUrl);
  const auth = await relayAuthenticate(relayUrl, input.mode, input.email, input.password);
  const session: RelaySession = {
    relayUrl,
    accessToken: auth.accessToken,
    refreshToken: auth.refreshToken,
    account: auth.account,
  };
  await setRelaySession(session);
  // Connect immediately if cloud is enabled; otherwise the session is stored and a
  // later enable (syncRelayToSettings) brings the host online.
  if (input.cloudEnabled) startClient(session);
  else stopClient();
  pushStatus();
  return getStatus();
}

// One Google sign-in attempt at a time: starting a new one aborts the previous
// waiter (its loopback server closes in that attempt's own finally).
let googleLoginAbort: AbortController | null = null;

/** How long the loopback waits for the user to finish the browser sign-in. */
const GOOGLE_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
/** Fixed loopback callback path — must match the relay's handoff redirect. */
const GOOGLE_HANDOFF_PATH = '/oauth/relay/callback';

/**
 * Log in to the relay with Google (B4 desktop flow): start a transient loopback
 * server, resolve the provider authorize URL from the relay
 * (`/auth/google?handoff_port=N` → its 302 target, so a down/unconfigured relay
 * errors here instead of as a dead browser tab), open the SYSTEM browser
 * directly on Google's sign-in page, then trade the one-time code the relay
 * redirected back with for the session. On success the Google identity is also
 * linked onto the active profile (the ProfileSwitcher badge).
 */
export async function loginWithGoogle(input: {
  relayUrl: string;
  cloudEnabled: boolean;
}): Promise<RelayStatus> {
  const relayUrl = normalizeRelayUrl(input.relayUrl);
  googleLoginAbort?.abort();
  const abort = new AbortController();
  googleLoginAbort = abort;
  const loopback = await startLoopbackServer({
    host: '127.0.0.1',
    ports: [],
    allowEphemeral: true,
    path: GOOGLE_HANDOFF_PATH,
  });
  try {
    const port = Number(new URL(loopback.redirectUri).port);
    const authorizeUrl = await relayGoogleAuthorizeUrl(relayUrl, port);
    const opened = await openExternalUrl(authorizeUrl);
    if (!opened) throw new Error('could not open the browser for Google sign-in');
    const { code } = await loopback.waitForCallback(GOOGLE_LOGIN_TIMEOUT_MS, abort.signal);
    const auth = await relayHandoffExchange(relayUrl, code);
    const session: RelaySession = {
      relayUrl,
      accessToken: auth.accessToken,
      refreshToken: auth.refreshToken,
      account: auth.account,
    };
    await setRelaySession(session);
    if (auth.account.method === 'google') {
      await setActiveProfileAccount({
        provider: 'google',
        email: auth.account.email,
        ...(auth.account.displayName ? { displayName: auth.account.displayName } : {}),
      });
    }
    if (input.cloudEnabled) startClient(session);
    else stopClient();
    pushStatus();
    return getStatus();
  } finally {
    if (googleLoginAbort === abort) googleLoginAbort = null;
    loopback.close();
  }
}

/** Log out: best-effort relay logout, drop the local session, disconnect. */
export async function logout(): Promise<RelayStatus> {
  const session = await getRelaySession();
  stopClient();
  await clearRelaySession();
  if (session) await relayLogout(session.relayUrl, session.refreshToken, session.accessToken);
  // A Google-linked profile badge mirrors the relay session — clear it together.
  if (session?.account.method === 'google') await setActiveProfileAccount(null);
  pushStatus();
  return getStatus();
}

/** Tear down on app quit — stop reconnecting and close the socket. */
export function disposeRelay(): void {
  stopClient();
}

/** Whether cloud was enabled at last reconcile (test/diagnostic helper). */
export function isCloudEnabled(): boolean {
  return lastEnabled;
}

/** Register the `relay:*` IPC handlers (validated; tokens never returned). */
export function registerRelayHandlers(): void {
  defineHandler('relay:login', async ([payload]) => {
    const o = obj(payload);
    return login({
      relayUrl: nonEmptyStr(o.relayUrl, 'relayUrl'),
      email: nonEmptyStr(o.email, 'email'),
      password: str(o.password, 'password'),
      mode: enumOf(o.mode, ['login', 'signup'] as const, 'mode'),
      // The auto-connect rule keys off the persisted flag, so read it here rather
      // than trusting the renderer to send it.
      cloudEnabled: getSettingsSync().server.cloudEnabled,
    });
  });

  defineHandler('relay:login-google', async ([payload]) => {
    const o = obj(payload);
    return loginWithGoogle({
      relayUrl: nonEmptyStr(o.relayUrl, 'relayUrl'),
      cloudEnabled: getSettingsSync().server.cloudEnabled,
    });
  });

  defineHandler('relay:logout', () => logout());

  defineHandler('relay:status', () => getStatus());
}
