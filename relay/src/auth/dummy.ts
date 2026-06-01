import { hashPassword, verifyPassword } from '../crypto/password.ts';

/**
 * A precomputed scrypt hash over a throwaway password, used to keep login's
 * failure path constant-time when the email is UNKNOWN. Without it, "no such
 * user" would return immediately while "wrong password" would pay for a scrypt
 * derivation — a timing oracle for user enumeration. We instead run a real
 * verify against this dummy record so both branches do the same work.
 *
 * Generated once, lazily, at first use (its own value is irrelevant).
 */
let dummy: { passwordHash: string; passwordSalt: string } | null = null;
let dummyReady: Promise<void> | null = null;

async function ensureDummy(): Promise<void> {
  if (dummy) return;
  if (!dummyReady) {
    dummyReady = hashPassword('marudesk-relay-dummy-password').then((h) => {
      dummy = h;
    });
  }
  await dummyReady;
}

/** Run a verify against the dummy record; the result is discarded (always treat as fail). */
export async function verifyPasswordDummy(password: string): Promise<boolean> {
  await ensureDummy();
  // dummy is set after ensureDummy resolves.
  await verifyPassword(password, dummy as { passwordHash: string; passwordSalt: string });
  return false;
}
