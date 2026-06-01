/**
 * Tiny in-memory per-key rate limiter (token bucket) for the auth endpoints.
 * Keyed by client IP. Not distributed (single-process dev/relay) — a real
 * deployment fronts this with a shared store / edge limiter, but this stops
 * trivial brute-force/credential-stuffing locally. No external dep.
 */

type Bucket = { tokens: number; updatedAt: number };

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerMs: number;

  /** @param capacity burst size. @param refillPerSec tokens regained per second. */
  constructor(capacity = 10, refillPerSec = 0.5) {
    this.capacity = capacity;
    this.refillPerMs = refillPerSec / 1000;
  }

  /** Consume one token for `key`. Returns true if allowed, false if limited. */
  take(key: string, now = Date.now()): boolean {
    const bucket = this.buckets.get(key);
    if (!bucket) {
      this.buckets.set(key, { tokens: this.capacity - 1, updatedAt: now });
      return true;
    }
    const elapsed = now - bucket.updatedAt;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerMs);
    bucket.updatedAt = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /** Drop buckets idle long enough to have fully refilled (call periodically). */
  sweep(now = Date.now()): void {
    const fullRefillMs = this.capacity / this.refillPerMs;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updatedAt > fullRefillMs) this.buckets.delete(key);
    }
  }
}
