import { createHmac } from 'node:crypto';
import { safeEqual } from './safe.ts';

/**
 * Minimal HS256 JWT (no external lib), per RFC 7519. Header is fixed
 * `{alg:'HS256',typ:'JWT'}`. Signature is HMAC-SHA256 over `header.payload`,
 * base64url-encoded. Verification recomputes the signature and compares it in
 * constant time, rejects a non-HS256 `alg` (no `alg:none` confusion), and
 * enforces `exp`. The signing secret is supplied by the caller and never logged.
 */

type JwtHeader = { alg: 'HS256'; typ: 'JWT' };
const HEADER: JwtHeader = { alg: 'HS256', typ: 'JWT' };

/** Standard claims we use. `sub` = account id; `typ` distinguishes access/refresh. */
export type JwtClaims = {
  sub: string;
  typ: 'access' | 'refresh';
  /** issued-at (seconds since epoch). */
  iat: number;
  /** expiry (seconds since epoch). */
  exp: number;
  /** opaque token id — lets refresh tokens be rotated/revoked individually. */
  jti: string;
};

export type VerifyResult =
  | { ok: true; claims: JwtClaims }
  | { ok: false; reason: 'malformed' | 'bad-signature' | 'expired' | 'bad-claims' };

function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Buffer {
  // Reject anything that isn't valid base64url before decoding (Buffer is lax).
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('bad base64url');
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function sign(signingInput: string, secret: string): string {
  return b64urlEncode(createHmac('sha256', secret).update(signingInput).digest());
}

/** Encode + sign a JWT for the given claims. */
export function signJwt(claims: JwtClaims, secret: string): string {
  const header = b64urlEncode(Buffer.from(JSON.stringify(HEADER), 'utf8'));
  const payload = b64urlEncode(Buffer.from(JSON.stringify(claims), 'utf8'));
  const signingInput = `${header}.${payload}`;
  return `${signingInput}.${sign(signingInput, secret)}`;
}

function isClaims(value: unknown): value is JwtClaims {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.sub === 'string' &&
    (c.typ === 'access' || c.typ === 'refresh') &&
    typeof c.iat === 'number' &&
    typeof c.exp === 'number' &&
    typeof c.jti === 'string'
  );
}

/**
 * Verify signature + structure + expiry. `nowSec` is injectable for tests.
 * Returns a discriminated result rather than throwing so callers can map every
 * failure to a single generic 401 without branching on exceptions.
 */
export function verifyJwt(token: string, secret: string, nowSec = Math.floor(Date.now() / 1000)): VerifyResult {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [header, payload, signature] = parts as [string, string, string];

  let headerObj: unknown;
  let payloadObj: unknown;
  try {
    headerObj = JSON.parse(b64urlDecode(header).toString('utf8'));
    payloadObj = JSON.parse(b64urlDecode(payload).toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  // Reject any algorithm other than HS256 (prevents `alg:none` / alg-swap).
  if (
    typeof headerObj !== 'object' ||
    headerObj === null ||
    (headerObj as Record<string, unknown>).alg !== 'HS256'
  ) {
    return { ok: false, reason: 'bad-signature' };
  }

  const expected = sign(`${header}.${payload}`, secret);
  if (!safeEqual(signature, expected)) return { ok: false, reason: 'bad-signature' };

  if (!isClaims(payloadObj)) return { ok: false, reason: 'bad-claims' };
  if (payloadObj.exp <= nowSec) return { ok: false, reason: 'expired' };
  return { ok: true, claims: payloadObj };
}
