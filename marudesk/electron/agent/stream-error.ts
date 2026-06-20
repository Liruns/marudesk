import { APICallError } from 'ai';

/**
 * Pure stream-error classification + retry helpers for the agent loop
 * (SECOND-PASS items 1 & 2). Decides what a failed `streamText` call should do
 * NEXT, replacing the loop's old "any 429/5xx → provider failover" reflex:
 *
 *  - `retry`    — a transient provider blip (429 / overload / 5xx / network).
 *                 Retry the SAME model with exponential backoff, honoring a
 *                 server-supplied `Retry-After` when present. Today marudesk
 *                 only fails over; a single-provider user (Anthropic OAuth, no
 *                 fallback) hard-fails on a 429 instead of waiting it out.
 *  - `compact`  — a context-window OVERFLOW (the prompt is too long). The right
 *                 fix is compaction + retry, NOT swapping models (a different
 *                 model has the same prompt and the same window). `isFailoverError`
 *                 used to mis-route these.
 *  - `failover` — a quota/billing exhaustion or a non-overflow client error the
 *                 same provider can't recover from; try the next configured model.
 *  - `fatal`    — auth (401/403), a bad/retired model, a malformed-request 400
 *                 (incl. thinking-block structure errors mis-read as token
 *                 errors), or anything else a retry/compaction/failover won't
 *                 fix. Surface it.
 *
 * Pure + dependency-light: imports only `APICallError` from `ai` (a class with a
 * static `isInstance`), so this strips cleanly under the bare-node harness and
 * is unit-testable without the loop.
 */

/** What the loop should do with a failed model call. */
export type StreamErrorAction = 'retry' | 'compact' | 'failover' | 'fatal';

export type StreamErrorClass = {
  action: StreamErrorAction;
  /** HTTP status when the error was an APICallError, else undefined. */
  status?: number;
  /**
   * Suggested delay (ms) before a `retry`, derived from a `Retry-After` header
   * when the provider sent one; undefined → the caller uses its own backoff.
   */
  retryAfterMs?: number;
};

/**
 * Substrings that mark a context-window OVERFLOW (prompt too long). Matched
 * case-insensitively against the error message + response body. Mirrors omo's
 * `anthropic-context-window-limit-recovery/parser.ts` keyword set, trimmed to the
 * unambiguous phrases (we deliberately drop bare "max_tokens"/"token limit",
 * which can also describe an OUTPUT cap — that's not an input overflow).
 */
const OVERFLOW_KEYWORDS = [
  'prompt is too long',
  // NOT a bare 'is too long' — that also matches field/argument length-validation
  // 400s that compaction can't fix (it would mangle the transcript and burn the
  // overflow-compaction budget). Keep only anchored, unambiguous overflow phrases.
  'context_length_exceeded',
  'context length exceeded',
  'maximum context length',
  'exceeds the maximum',
  'too many total tokens',
  'input length and `max_tokens` exceed',
  'reduce the length',
];

/** "current > maximum" token-count shapes — a strong overflow signal. */
const OVERFLOW_TOKEN_PATTERNS = [
  /(\d[\d,]*)\s*tokens?\s*>\s*(\d[\d,]*)\s*maximum/i,
  /prompt.*?(\d[\d,]*).*?tokens.*?exceeds.*?(\d[\d,]*)/i,
  /context.*?length.*?(\d[\d,]*).*?maximum.*?(\d[\d,]*)/i,
];

/**
 * Patterns that look token-ish but are actually a THINKING-BLOCK structure 400
 * (Opus 4.x rejecting a thinking/redacted_thinking arrangement). These must NOT
 * be treated as an overflow — compaction would loop forever on a 400 that has
 * nothing to do with size. Mirrors omo's THINKING_BLOCK_ERROR_PATTERNS.
 */
const THINKING_BLOCK_PATTERNS = [
  /thinking.*first block/i,
  /first block.*thinking/i,
  /must.*start.*thinking/i,
  /thinking.*redacted_thinking/i,
  /expected.*thinking.*found/i,
  /thinking.*disabled.*cannot.*contain/i,
];

/**
 * Quota / billing EXHAUSTION (vs a transient rate-limit). An exhausted account
 * won't recover by waiting a few seconds — skip straight to failover so the
 * chain tries another provider instead of backing off in place. Conservative:
 * only phrases that clearly mean "you're out", never a plain "rate limit".
 */
const QUOTA_EXHAUSTED_KEYWORDS = [
  'insufficient_quota',
  'exceeded your current quota',
  'billing',
  'credit balance is too low',
  'payment required',
  'quota exceeded',
  'usage limit',
  'spending limit',
];

function lower(s: string | undefined): string {
  return typeof s === 'string' ? s.toLowerCase() : '';
}

function isThinkingBlockError(text: string): boolean {
  return THINKING_BLOCK_PATTERNS.some((re) => re.test(text));
}

/**
 * Whether the combined error text describes a context-window OVERFLOW. Excludes
 * thinking-block structure errors (which can carry token-ish wording) so a 400
 * about block ordering is never mistaken for "too long".
 */
export function isContextOverflowText(text: string): boolean {
  if (!text) return false;
  if (isThinkingBlockError(text)) return false;
  const lo = text.toLowerCase();
  if (OVERFLOW_KEYWORDS.some((kw) => lo.includes(kw))) return true;
  return OVERFLOW_TOKEN_PATTERNS.some((re) => re.test(text));
}

function isQuotaExhaustedText(text: string): boolean {
  const lo = lower(text);
  return QUOTA_EXHAUSTED_KEYWORDS.some((kw) => lo.includes(kw));
}

/**
 * Parse a `Retry-After` header value into milliseconds. The header is either a
 * delay in seconds (`"30"`) or an HTTP date (`"Wed, 21 Oct 2026 07:28:00 GMT"`).
 * Returns undefined for an absent/unparseable value or a past date. Capped at
 * {@link RETRY_AFTER_CAP_MS} so a hostile/huge value can't wedge the turn.
 */
export function parseRetryAfterMs(value: string | undefined, nowMs = Date.now()): number | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  // Numeric seconds.
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) return undefined;
    return Math.min(Math.round(seconds * 1000), RETRY_AFTER_CAP_MS);
  }
  // HTTP date.
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return undefined;
  const delta = when - nowMs;
  if (delta <= 0) return undefined;
  return Math.min(delta, RETRY_AFTER_CAP_MS);
}

/** Hard cap on an honored Retry-After (5 minutes) — a sane upper bound. */
export const RETRY_AFTER_CAP_MS = 300_000;

/** Pull the `Retry-After` header from an APICallError's response headers. */
function retryAfterFromError(err: APICallError): number | undefined {
  const headers = err.responseHeaders;
  if (!headers) return undefined;
  // Header names are case-insensitive; the SDK normalizes to lower-case, but be
  // defensive and check the common casings.
  const raw = headers['retry-after'] ?? headers['Retry-After'] ?? headers['retryAfter'];
  return parseRetryAfterMs(typeof raw === 'string' ? raw : undefined);
}

/** Combine an APICallError's message + response body into one searchable string. */
function errorText(err: APICallError): string {
  const body = typeof err.responseBody === 'string' ? err.responseBody : '';
  return `${err.message ?? ''}\n${body}`;
}

/**
 * Classify a failed `streamText` error into the loop's next action. Order
 * matters: an overflow can arrive as a 400 (Anthropic) OR a 413, so we test the
 * message BEFORE the status-class buckets; quota-exhaustion is split out of the
 * 429 bucket so an out-of-credit account fails over instead of backing off.
 *
 * Non-APICallError values (network failures: timeout, ECONNRESET, fetch failed)
 * are transient → `retry`. Everything unrecognized is `fatal` (don't silently
 * mask a real misconfig).
 */
export function classifyStreamError(err: unknown): StreamErrorClass {
  if (!APICallError.isInstance(err)) {
    if (err instanceof Error && /timeout|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|fetch failed|network/i.test(err.message)) {
      return { action: 'retry' };
    }
    return { action: 'fatal' };
  }

  const status = err.statusCode;
  const text = errorText(err);

  // 1) Context-window overflow — route to COMPACTION regardless of the status
  //    code it arrived under (Anthropic 400, OpenAI 400, some gateways 413).
  if (isContextOverflowText(text)) {
    return { action: 'compact', status };
  }

  // 2) Auth — a different model/retry won't fix a bad key. Fatal.
  if (status === 401 || status === 403) {
    return { action: 'fatal', status };
  }

  // 3) Rate-limit / overload (429) — split quota-EXHAUSTION (failover) from a
  //    transient rate-limit (retry with backoff, honoring Retry-After).
  if (status === 429) {
    if (isQuotaExhaustedText(text)) {
      return { action: 'failover', status };
    }
    return { action: 'retry', status, retryAfterMs: retryAfterFromError(err) };
  }

  // 4) Transient server / overload (5xx incl. Anthropic's 529) — retry the same
  //    model with backoff first; the caller falls over only once retries spend.
  if (typeof status === 'number' && status >= 500) {
    return { action: 'retry', status, retryAfterMs: retryAfterFromError(err) };
  }

  // 5) Other 4xx (400/404/422 …) that isn't an overflow: a malformed request,
  //    retired model, or thinking-block structure error. Fatal — neither a
  //    retry, a compaction, nor a different provider fixes a bad request.
  return { action: 'fatal', status };
}

/** Default backoff schedule for `retry` when no Retry-After is supplied. */
export function backoffDelayMs(attempt: number, baseMs = 1000, capMs = 8000): number {
  return Math.min(baseMs * 2 ** attempt, capMs);
}
