/**
 * Shared helpers for the provider `listModels` paths (electron/providers/*.ts).
 * The agent now generates through the Vercel AI SDK
 * (electron/agent/model.ts, docs/agentic-chat-v2-design.md §4 / decision D1), so
 * the hand-rolled `propose_patch` plumbing that used to live here is gone. What
 * remains is the credential-error typing and the model-id label formatter the
 * live-catalog fetchers share.
 */

/**
 * Raised by a driver's `listModels` when the provider rejects the credential
 * (HTTP 401/403). Distinct from transient/network failures so callers can tell
 * "your key is wrong" apart from "the network hiccuped" — the former should
 * surface to the user (and power the Settings "Test connection" button), the
 * latter should fall back to the static catalog.
 */
export class ProviderAuthError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ProviderAuthError';
    this.status = status;
  }
}

/** True when an HTTP status means the credential was rejected. */
export function isAuthStatus(status: number): boolean {
  return status === 401 || status === 403;
}

/** "claude-sonnet-4-5-20251022" → "Claude Sonnet 4 5 20251022". */
export function prettifyId(id: string): string {
  return id.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
