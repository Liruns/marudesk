import { randomBytes, scrypt as scryptCb } from 'node:crypto';
import { promisify } from 'node:util';
import { safeEqualBytes } from './safe.ts';

/**
 * Password hashing with Node's built-in `crypto.scrypt` (no external lib). Each
 * password gets a fresh 16-byte random salt; we store salt + derived key as hex.
 * Verification re-derives with the stored salt and compares in constant time.
 * Plaintext is never stored, returned, or logged.
 */

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

const SALT_BYTES = 16;
const KEY_BYTES = 64;

export type PasswordHash = { passwordHash: string; passwordSalt: string };

/** Derive a salted scrypt hash for a new/changed password. */
export async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(password, salt, KEY_BYTES);
  return { passwordHash: derived.toString('hex'), passwordSalt: salt.toString('hex') };
}

/**
 * Verify a candidate password against a stored salt+hash in constant time.
 * Returns false (never throws) on any malformed stored material so a corrupt
 * record can't crash the auth path or leak via an exception.
 */
export async function verifyPassword(
  password: string,
  stored: { passwordHash?: string; passwordSalt?: string },
): Promise<boolean> {
  if (!stored.passwordHash || !stored.passwordSalt) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(stored.passwordSalt, 'hex');
    expected = Buffer.from(stored.passwordHash, 'hex');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length !== KEY_BYTES) return false;
  const derived = await scrypt(password, salt, KEY_BYTES);
  return safeEqualBytes(derived, expected);
}
