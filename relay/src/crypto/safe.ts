import { timingSafeEqual } from 'node:crypto';

/**
 * Length-guarded constant-time string compare. `timingSafeEqual` throws if the
 * two buffers differ in length, and that throw itself leaks length via timing /
 * control-flow — so we hash-fold both inputs to a fixed width is overkill here;
 * instead we compare equal-length buffers only after an explicit length check
 * that is itself not short-circuited on the secret. We compare the UTF-8 bytes.
 *
 * Used for: JWT signature compare, and any place two secrets/tokens are matched.
 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // Length mismatch can't be hidden, but we still run a constant-time compare of
  // `ab` against itself so the rejection path takes a similar amount of work and
  // never calls timingSafeEqual with mismatched lengths (which throws).
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** Constant-time compare of two raw byte buffers (e.g. derived password hashes). */
export function safeEqualBytes(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}
