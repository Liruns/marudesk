import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The CLI bridge's bearer secret. Generated on first need as 32
 * cryptographically-random bytes (base64url) and persisted via electron/secrets.ts
 * (safeStorage-encrypted). Every endpoint requires `Authorization: Bearer <token>`;
 * the token is never logged nor sent to the renderer — it reaches a local terminal
 * client only via the companion's 0600 handshake file.
 *
 * The secrets module (which pulls in `electron`) is imported lazily inside
 * {@link getServerToken} so this module's static graph stays Electron-free — the
 * headless router harness can load it (for {@link verifyToken}) without Electron.
 */

// Serialize concurrent first-need callers so two simultaneous getServerToken()
// calls can't each mint and persist a different secret (last-write-wins would
// then invalidate a token already handed out).
let pending: Promise<string> | null = null;

/** Get the stored server token, minting and persisting one on first need. */
export function getServerToken(): Promise<string> {
  if (pending) return pending;
  pending = (async () => {
    const { getServerTokenStored, setServerTokenStored } = await import('../secrets');
    const existing = await getServerTokenStored();
    if (existing) return existing;
    const token = randomBytes(32).toString('base64url');
    await setServerTokenStored(token);
    return token;
  })();
  // Don't cache a rejected attempt (e.g. safeStorage briefly unavailable) — let
  // the next call retry rather than wedging on a poisoned promise.
  pending.catch(() => {
    pending = null;
  });
  return pending;
}

/**
 * Constant-time bearer-token comparison. The length guard is required because
 * timingSafeEqual throws on length-mismatched buffers; comparing lengths first is
 * safe (the length of a rejected guess leaks nothing about the secret's bytes).
 */
export function verifyToken(presented: string, actual: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
