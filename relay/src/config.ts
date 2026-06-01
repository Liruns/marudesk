import { randomBytes } from 'node:crypto';

/**
 * Process configuration, read from env once at boot. Designed so the relay runs
 * for LOCAL dev with almost nothing set: on a loopback HOST (127.0.0.1/localhost/::1)
 * and outside production, an absent `JWT_SECRET` auto-generates an ephemeral secret
 * (with a loud warning), and OAuth simply reports "not configured" (the provider
 * config is absent → those endpoints 503). See .env.example.
 *
 * Fail-fast guards (refuse to boot rather than run insecure): an ephemeral secret is
 * REJECTED when NODE_ENV=production or HOST is non-loopback (e.g. the 0.0.0.0
 * default), and an explicitly-provided JWT_SECRET shorter than 32 bytes is rejected.
 */

export type OAuthProviderConfig = {
  clientId: string;
  clientSecret: string;
  /** Full redirect URI we register with the provider and pass in the auth request. */
  redirectUri: string;
};

export type Config = {
  port: number;
  host: string;
  jwtSecret: string;
  /** True when JWT_SECRET was absent and we minted a per-boot ephemeral secret. */
  jwtSecretEphemeral: boolean;
  accessTtlSec: number;
  refreshTtlSec: number;
  dataDir: string;
  /** Per-IP auth rate-limit: burst size and tokens regained per second. */
  authRateBurst: number;
  authRateRefillPerSec: number;
  /** Explicit allowed CORS origins (localhost is always allowed for dev too). */
  corsOrigins: string[];
  oauthRedirectBase: string;
  google: OAuthProviderConfig | null;
  github: OAuthProviderConfig | null;
};

/** Minimum accepted length for an explicitly-provided JWT_SECRET. */
const MIN_JWT_SECRET_BYTES = 32;

/** True iff `host` binds only the loopback interface (safe for ephemeral-secret dev). */
function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, ''); // strip [] from [::1]
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

function intEnv(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function floatEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function strEnv(name: string, fallback = ''): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

function providerEnv(
  prefix: 'GOOGLE' | 'GITHUB',
  provider: 'google' | 'github',
  redirectBase: string,
): OAuthProviderConfig | null {
  const clientId = strEnv(`${prefix}_CLIENT_ID`);
  const clientSecret = strEnv(`${prefix}_CLIENT_SECRET`);
  // Both halves required; otherwise the provider stays "not configured" (503).
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    redirectUri: `${redirectBase.replace(/\/+$/, '')}/auth/${provider}/callback`,
  };
}

/** Build the config from `process.env`, logging the ephemeral-secret warning. */
export function loadConfig(): Config {
  const port = intEnv('PORT', 8788, 0); // allow 0 = OS-assigned ephemeral port
  const host = strEnv('HOST', '0.0.0.0');

  let jwtSecret = strEnv('JWT_SECRET');
  const jwtSecretEphemeral = jwtSecret === '';
  if (jwtSecretEphemeral) {
    // Refuse to boot with an auto-generated secret in any non-local-dev posture:
    // ephemeral secrets silently invalidate every token on restart and offer no
    // shared trust across instances. Allowed ONLY for loopback dev.
    if (process.env.NODE_ENV === 'production' || !isLoopbackHost(host)) {
      throw new Error(
        '[relay] refusing to start: JWT_SECRET is not set. An ephemeral secret is only ' +
          'allowed for local dev (loopback HOST, non-production). Set JWT_SECRET (>= 32 ' +
          'bytes) for any externally-bound or production deployment.',
      );
    }
    jwtSecret = randomBytes(48).toString('hex');
    console.warn(
      '[relay] WARNING: JWT_SECRET is not set — using an EPHEMERAL secret generated ' +
        'for this boot only. All tokens become invalid on restart. Set JWT_SECRET ' +
        'for any persistent/production use.',
    );
  } else if (Buffer.byteLength(jwtSecret, 'utf8') < MIN_JWT_SECRET_BYTES) {
    // A provided-but-weak secret is worse than ephemeral: it looks intentional.
    throw new Error(
      `[relay] refusing to start: JWT_SECRET is too short (< ${MIN_JWT_SECRET_BYTES} bytes). ` +
        'Use a high-entropy secret of at least 32 bytes.',
    );
  }

  const oauthRedirectBase = strEnv('OAUTH_REDIRECT_BASE', `http://localhost:${port}`);

  return {
    port,
    host,
    jwtSecret,
    jwtSecretEphemeral,
    accessTtlSec: intEnv('ACCESS_TOKEN_TTL_SEC', 900),
    refreshTtlSec: intEnv('REFRESH_TOKEN_TTL_SEC', 2592000),
    dataDir: strEnv('DATA_DIR', 'relay-data'),
    authRateBurst: intEnv('AUTH_RATE_BURST', 10),
    authRateRefillPerSec: floatEnv('AUTH_RATE_REFILL_PER_SEC', 0.5),
    corsOrigins: strEnv('CORS_ORIGINS')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    oauthRedirectBase,
    google: providerEnv('GOOGLE', 'google', oauthRedirectBase),
    github: providerEnv('GITHUB', 'github', oauthRedirectBase),
  };
}
