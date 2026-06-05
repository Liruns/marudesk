import { randomUUID } from 'node:crypto';
import type { Account, AccountMethod, AccountStore, PublicAccount } from '../accounts/store.ts';
import { toPublicAccount } from '../accounts/store.ts';
import { signJwt, verifyJwt, type JwtClaims } from '../crypto/jwt.ts';
import { hashPassword, verifyPassword } from '../crypto/password.ts';
import { verifyPasswordDummy } from './dummy.ts';
import { normalizeEmail } from './normalize.ts';

/**
 * Authentication service: signup / login / refresh / token verification, plus the
 * OAuth identity → account mapping. Pure aside from the injected {@link AccountStore}
 * and clock — no HTTP here, so it's exercised directly by the harness.
 *
 * Security choices baked in:
 *  - Passwords hashed with scrypt + per-user salt (../crypto/password.ts).
 *  - Login does a constant-time-ish failure: on an unknown email we still run a
 *    dummy scrypt verify so response time doesn't reveal whether the email exists,
 *    and BOTH "no such user" and "wrong password" return the SAME generic error
 *    (no user enumeration).
 *  - Tokens are HS256 JWTs; refresh tokens carry a `jti` and ROTATE on every use.
 *    Each account has a bounded SET of currently-valid refresh jtis (one per live
 *    session — Model B runs PC host + phone client on the same account at once), so
 *    one device logging in does not evict another. Refresh is one-time-use: the
 *    presented jti must be in the set, is removed, and the new jti is added; a
 *    replayed/consumed jti is rejected.
 *  - The signing secret is held here and never returned or logged.
 */

export type TokenPair = { accessToken: string; refreshToken: string; expiresInSec: number };

export type AuthErrorCode =
  | 'invalid-input'
  | 'email-taken'
  | 'invalid-credentials'
  | 'invalid-refresh'
  | 'unauthorized';

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  constructor(code: AuthErrorCode, message: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

export type AuthDeps = {
  store: AccountStore;
  secret: string;
  accessTtlSec: number;
  refreshTtlSec: number;
  /** Injectable clock (seconds since epoch) for deterministic tests. */
  now?: () => number;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LEN = 254;
const MIN_PASSWORD_LEN = 8;
const MAX_PASSWORD_LEN = 200;

function nowSec(deps: AuthDeps): number {
  return (deps.now ?? (() => Math.floor(Date.now() / 1000)))();
}

/** Validate + normalize an {email,password} body. Throws AuthError('invalid-input'). */
function parseCredentials(body: unknown): { email: string; password: string } {
  if (typeof body !== 'object' || body === null) {
    throw new AuthError('invalid-input', 'expected a JSON object');
  }
  const { email, password } = body as Record<string, unknown>;
  if (typeof email !== 'string' || typeof password !== 'string') {
    throw new AuthError('invalid-input', 'email and password are required');
  }
  const normEmail = normalizeEmail(email);
  if (normEmail.length > MAX_EMAIL_LEN || !EMAIL_RE.test(normEmail)) {
    throw new AuthError('invalid-input', 'a valid email is required');
  }
  if (password.length < MIN_PASSWORD_LEN || password.length > MAX_PASSWORD_LEN) {
    throw new AuthError('invalid-input', `password must be ${MIN_PASSWORD_LEN}-${MAX_PASSWORD_LEN} characters`);
  }
  return { email: normEmail, password };
}

/**
 * Track the currently-valid refresh jtis per account as a SET — one entry per live
 * session (e.g. PC host + phone client), so issuing a token for one device doesn't
 * invalidate another's. Bounded per account (oldest evicted) so it can't grow
 * unbounded under repeated logins.
 */
const activeRefreshJtis = new Map<string, Set<string>>();

/** Max simultaneous refresh jtis kept per account; oldest are evicted past this. */
const MAX_REFRESH_JTIS_PER_ACCOUNT = 10;

/** Record a freshly-issued refresh jti for an account, evicting the oldest past the cap. */
function rememberRefreshJti(accountId: string, jti: string): void {
  let set = activeRefreshJtis.get(accountId);
  if (!set) {
    set = new Set();
    activeRefreshJtis.set(accountId, set);
  }
  set.add(jti); // insertion order preserved → oldest is the first entry
  while (set.size > MAX_REFRESH_JTIS_PER_ACCOUNT) {
    const oldest = set.values().next().value;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
}

function issueTokens(deps: AuthDeps, accountId: string): TokenPair {
  const iat = nowSec(deps);
  const accessClaims: JwtClaims = {
    sub: accountId,
    typ: 'access',
    iat,
    exp: iat + deps.accessTtlSec,
    jti: randomUUID(),
  };
  const refreshJti = randomUUID();
  const refreshClaims: JwtClaims = {
    sub: accountId,
    typ: 'refresh',
    iat,
    exp: iat + deps.refreshTtlSec,
    jti: refreshJti,
  };
  rememberRefreshJti(accountId, refreshJti);
  return {
    accessToken: signJwt(accessClaims, deps.secret),
    refreshToken: signJwt(refreshClaims, deps.secret),
    expiresInSec: deps.accessTtlSec,
  };
}

/** Create a local (email+password) account, then issue tokens. */
export async function signup(
  deps: AuthDeps,
  body: unknown,
): Promise<{ account: PublicAccount; tokens: TokenPair }> {
  const { email, password } = parseCredentials(body);
  const existing = await deps.store.findByEmail(email);
  if (existing) throw new AuthError('email-taken', 'email already registered');

  const { passwordHash, passwordSalt } = await hashPassword(password);
  const account: Account = {
    id: randomUUID(),
    method: 'local',
    email,
    passwordHash,
    passwordSalt,
    createdAt: new Date().toISOString(),
  };
  await deps.store.create(account);
  return { account: toPublicAccount(account), tokens: issueTokens(deps, account.id) };
}

/** Verify email+password and issue tokens. Generic failure (no enumeration). */
export async function login(
  deps: AuthDeps,
  body: unknown,
): Promise<{ account: PublicAccount; tokens: TokenPair }> {
  const { email, password } = parseCredentials(body);
  const account = await deps.store.findByEmail(email);
  // Always run a verify (dummy when the user is unknown) so timing doesn't leak
  // existence, and collapse both failures into one generic error.
  const ok = account
    ? await verifyPassword(password, account)
    : await verifyPasswordDummy(password);
  if (!account || !ok) {
    throw new AuthError('invalid-credentials', 'invalid email or password');
  }
  return { account: toPublicAccount(account), tokens: issueTokens(deps, account.id) };
}

/** Rotate a refresh token → a fresh access+refresh pair. Old refresh becomes invalid. */
export async function refresh(deps: AuthDeps, body: unknown): Promise<{ tokens: TokenPair }> {
  if (typeof body !== 'object' || body === null) {
    throw new AuthError('invalid-input', 'refreshToken is required');
  }
  const { refreshToken } = body as Record<string, unknown>;
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    throw new AuthError('invalid-input', 'refreshToken is required');
  }
  const result = verifyJwt(refreshToken, deps.secret, nowSec(deps));
  if (!result.ok || result.claims.typ !== 'refresh') {
    throw new AuthError('invalid-refresh', 'invalid or expired refresh token');
  }
  // Reject a replayed/consumed refresh token: the presented jti must be one of the
  // account's currently-valid jtis. Consume it (one-time use) before rotating in the
  // new pair — replay of this same jti will now miss the set and be rejected. Other
  // live sessions' jtis stay valid.
  const set = activeRefreshJtis.get(result.claims.sub);
  if (!set || !set.delete(result.claims.jti)) {
    throw new AuthError('invalid-refresh', 'refresh token has been rotated');
  }
  const account = await deps.store.findById(result.claims.sub);
  if (!account) throw new AuthError('invalid-refresh', 'invalid or expired refresh token');
  return { tokens: issueTokens(deps, account.id) };
}

/**
 * Log out a single session: remove the presented refresh token's jti from the
 * account's valid set, so that token can no longer be rotated. Other live sessions
 * on the same account are unaffected. The body must carry a `refreshToken`; an
 * optional Bearer `accessToken` is accepted for symmetry but isn't required (the
 * refresh jti is what identifies the session). Always succeeds generically once
 * input validates — we don't reveal whether the jti was actually present.
 */
export async function logout(
  deps: AuthDeps,
  body: unknown,
  accessToken?: string | null,
): Promise<void> {
  if (typeof body !== 'object' || body === null) {
    throw new AuthError('invalid-input', 'refreshToken is required');
  }
  const { refreshToken } = body as Record<string, unknown>;
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    throw new AuthError('invalid-input', 'refreshToken is required');
  }
  const result = verifyJwt(refreshToken, deps.secret, nowSec(deps));
  if (result.ok && result.claims.typ === 'refresh') {
    activeRefreshJtis.get(result.claims.sub)?.delete(result.claims.jti);
  }
  // An expired/invalid refresh token (or a stale access token) is a no-op: the
  // session is already unusable. We intentionally ignore `accessToken` for removal.
  void accessToken;
}

/**
 * Verify an access token and return the bound account. Used by `GET /me` and to
 * authenticate the WS upgrade. Any failure → AuthError('unauthorized').
 */
export async function authenticate(deps: AuthDeps, accessToken: string): Promise<Account> {
  const result = verifyJwt(accessToken, deps.secret, nowSec(deps));
  if (!result.ok || result.claims.typ !== 'access') {
    throw new AuthError('unauthorized', 'unauthorized');
  }
  const account = await deps.store.findById(result.claims.sub);
  if (!account) throw new AuthError('unauthorized', 'unauthorized');
  return account;
}

/**
 * Map a verified OAuth identity to an account: link by provider-sub, else adopt
 * an existing same-email account, else create one. Then issue tokens. Used by the
 * OAuth callbacks once the provider has been exchanged for an identity.
 */
export async function loginWithOAuthIdentity(
  deps: AuthDeps,
  identity: { method: Exclude<AccountMethod, 'local'>; providerSub: string; email: string; displayName?: string },
): Promise<{ account: PublicAccount; tokens: TokenPair }> {
  const email = normalizeEmail(identity.email);
  let account =
    (await deps.store.findByProvider(identity.method, identity.providerSub)) ??
    (await deps.store.findByEmail(email));

  if (!account) {
    account = {
      id: randomUUID(),
      method: identity.method,
      email,
      providerSub: identity.providerSub,
      createdAt: new Date().toISOString(),
      ...(identity.displayName !== undefined ? { displayName: identity.displayName } : {}),
    };
    await deps.store.create(account);
  } else if (!account.providerSub || account.method !== identity.method) {
    // Link the provider identity onto a pre-existing (e.g. local) account.
    account = { ...account, method: identity.method, providerSub: identity.providerSub };
    await deps.store.update(account);
  }
  return { account: toPublicAccount(account), tokens: issueTokens(deps, account.id) };
}

/** Test-only: clear the in-memory refresh-rotation state between harness cases. */
export function __resetRefreshState(): void {
  activeRefreshJtis.clear();
}
