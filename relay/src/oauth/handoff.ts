import { randomBytes } from 'node:crypto';
import type { PublicAccount } from '../accounts/store.ts';
import type { TokenPair } from '../auth/service.ts';

/**
 * One-time handoff codes for the desktop OAuth flow. When the marudesk app starts
 * the provider sign-in (GET /auth/<p>?handoff_port=N), the browser finishes the
 * web flow on the relay and is then redirected to the app's loopback server with
 * a short-lived code — NEVER with the tokens themselves (a URL can land in
 * browser history / proxy logs). The app exchanges the code over POST
 * /auth/handoff for the account + token pair. In-memory with a short TTL, same
 * trade-off as the CSRF state store (dev relay, single proc).
 */

export type HandoffResult = { account: PublicAccount; tokens: TokenPair };

const HANDOFF_TTL_MS = 2 * 60 * 1000;
const pending = new Map<string, { result: HandoffResult; expiresAt: number }>();

/** Mint a one-time code for a completed OAuth login. */
export function createHandoff(result: HandoffResult, now = Date.now()): string {
  // Lazy sweep so an abandoned sign-in can't grow the map unboundedly.
  for (const [code, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(code);
  }
  const code = randomBytes(32).toString('hex');
  pending.set(code, { result, expiresAt: now + HANDOFF_TTL_MS });
  return code;
}

/** Consume (one-time) a handoff code. Returns the login result iff valid + unexpired. */
export function consumeHandoff(code: string, now = Date.now()): HandoffResult | null {
  const entry = pending.get(code);
  if (!entry) return null;
  pending.delete(code);
  return entry.expiresAt > now ? entry.result : null;
}
