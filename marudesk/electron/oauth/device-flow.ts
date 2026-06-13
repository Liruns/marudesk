import type { OAuthTokens } from '../../shared/providers';
import { OAUTH_TOKEN_USER_AGENT } from './config';

/**
 * OAuth 2.0 Device Authorization Grant (RFC 8628) for providers that support it
 * (e.g. GitHub Copilot). The desktop app shows the user code and verification
 * URI, then polls for a token grant while the user authorizes in their browser.
 *
 * This complements the PKCE authorization-code flow in ./flow.ts — providers
 * that don't support loopback or manual-paste callbacks can use device flow
 * instead.
 */

/* ── types ──────────────────────────────────────────────────────────────── */

export type DeviceFlowConfig = {
  provider: string;
  clientId: string;
  scopes: string;
  /** The device authorization endpoint (e.g. https://github.com/login/device/code). */
  deviceAuthUrl: string;
  /** The token endpoint (e.g. https://github.com/login/oauth/access_token). */
  tokenUrl: string;
  /** OAuth grant type; defaults to the RFC 8628 URN. */
  grantType?: string;
};

export type DeviceCodeResponse = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  /** Seconds until the device code expires. */
  expiresIn: number;
  /** Minimum polling interval in seconds. */
  interval: number;
};

/* ── errors ─────────────────────────────────────────────────────────────── */

export class DeviceFlowHttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'DeviceFlowHttpError';
    this.status = status;
  }
}

export class DeviceFlowError extends Error {
  /** The `error` string from the token endpoint (e.g. `expired_token`). */
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DeviceFlowError';
    this.code = code;
  }
}

/* ── raw token-endpoint response shape ─────────────────────────────────── */

type DeviceAuthRaw = {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  verification_url?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
};

type TokenResponseRaw = {
  error?: string;
  error_description?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
};

/* ── helpers ────────────────────────────────────────────────────────────── */

const DEFAULT_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

/**
 * Build {@link OAuthTokens} from a successful device-flow token response.
 * GitHub device-flow tokens are long-lived and often omit `expires_in`; we
 * default to 8 hours so the refresh-skew logic in flow.ts still works.
 */
function tokensFromDeviceResponse(json: TokenResponseRaw): OAuthTokens {
  if (!json.access_token) {
    throw new Error('device flow token endpoint returned no access_token');
  }
  const seconds =
    typeof json.expires_in === 'number' && json.expires_in > 0
      ? json.expires_in
      : 28_800; // 8 hours
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || 'device-flow-no-refresh',
    expiresAt: Date.now() + seconds * 1000,
    scope: typeof json.scope === 'string' ? json.scope : undefined,
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal!.reason as Error);
    };
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/* ── public API ─────────────────────────────────────────────────────────── */

/**
 * Request a device code + user code from the provider's device authorization
 * endpoint (RFC 8628 §3.1). The caller should display `userCode` and open
 * `verificationUri` (or `verificationUriComplete`) in the user's browser.
 */
export async function requestDeviceCode(
  cfg: DeviceFlowConfig,
): Promise<DeviceCodeResponse> {
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    scope: cfg.scopes,
  });

  const resp = await fetch(cfg.deviceAuthUrl, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': OAUTH_TOKEN_USER_AGENT,
    },
    body: body.toString(),
  });

  if (!resp.ok) {
    const detail = (await resp.text().catch(() => '')).slice(0, 300);
    throw new DeviceFlowHttpError(
      `Device authorization endpoint returned HTTP ${resp.status}: ${detail}`,
      resp.status,
    );
  }

  const json = (await resp.json()) as DeviceAuthRaw;

  const deviceCode = json.device_code;
  const userCode = json.user_code;
  // GitHub uses `verification_uri`; some providers use `verification_url`.
  const verificationUri = json.verification_uri ?? json.verification_url;

  if (!deviceCode || !userCode || !verificationUri) {
    throw new Error(
      'Device authorization response missing required fields ' +
        '(device_code, user_code, verification_uri)',
    );
  }

  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: json.verification_uri_complete ?? undefined,
    expiresIn: typeof json.expires_in === 'number' ? json.expires_in : 900,
    interval: typeof json.interval === 'number' ? json.interval : 5,
  };
}

/**
 * Poll the token endpoint until the user completes authorization or the device
 * code expires (RFC 8628 §3.4–3.5). The returned promise resolves with tokens
 * on success, or rejects on expiry / denial / abort.
 *
 * Pass an {@link AbortSignal} to cancel polling early (e.g. the user closes
 * the authorization dialog).
 */
export async function pollForToken(
  cfg: DeviceFlowConfig,
  deviceCode: string,
  interval: number,
  expiresIn: number,
  signal?: AbortSignal,
): Promise<OAuthTokens> {
  const grantType = cfg.grantType ?? DEFAULT_GRANT_TYPE;
  const deadline = Date.now() + expiresIn * 1000;
  let pollInterval = interval;

  while (Date.now() < deadline) {
    signal?.throwIfAborted();

    await sleep(pollInterval * 1000, signal);

    signal?.throwIfAborted();

    const body = new URLSearchParams({
      client_id: cfg.clientId,
      device_code: deviceCode,
      grant_type: grantType,
    });

    let json: TokenResponseRaw;
    try {
      const resp = await fetch(cfg.tokenUrl, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': OAUTH_TOKEN_USER_AGENT,
        },
        body: body.toString(),
        signal,
      });

      json = (await resp.json()) as TokenResponseRaw;
    } catch {
      // Network errors during polling are retried (the user might have flaky
      // connectivity while they open a browser tab). AbortErrors propagate.
      if (signal?.aborted) throw signal.reason as Error;
      continue;
    }

    if (!json.error) {
      // Success — the user authorized.
      return tokensFromDeviceResponse(json);
    }

    switch (json.error) {
      case 'authorization_pending':
        // Not yet — keep polling at the current interval.
        continue;

      case 'slow_down':
        // RFC 8628 §3.5: increase interval by 5 seconds.
        pollInterval += 5;
        continue;

      case 'expired_token':
        throw new DeviceFlowError(
          'expired_token',
          json.error_description ?? 'The device code has expired. Please restart the authorization flow.',
        );

      case 'access_denied':
        throw new DeviceFlowError(
          'access_denied',
          json.error_description ?? 'The user denied the authorization request.',
        );

      default:
        throw new DeviceFlowError(
          json.error,
          json.error_description ?? `Device flow token error: ${json.error}`,
        );
    }
  }

  throw new DeviceFlowError(
    'expired_token',
    'The device code has expired (polling deadline reached). Please restart the authorization flow.',
  );
}
