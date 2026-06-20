import { APICallError } from 'ai';
import { check, passedCount } from '../harness-kit.ts';
import {
  classifyStreamError,
  isContextOverflowText,
  parseRetryAfterMs,
  backoffDelayMs,
  RETRY_AFTER_CAP_MS,
} from './stream-error.ts';

/**
 * Harness for the stream-error classifier (SECOND-PASS items 1 & 2). Pure: the
 * module imports only `APICallError` from `ai`, so this runs standalone under
 * `node --experimental-strip-types` (no Electron stub).
 *
 * Covers the routing table — transient → retry, overflow → compact, quota → failover,
 * auth/bad-request/thinking-block → fatal, network → retry — plus Retry-After parsing
 * (seconds, HTTP-date, garbage, cap) and the overflow/thinking-block disambiguation.
 */

/** Build an APICallError with a given status + body (+ optional headers). */
function apiError(
  status: number,
  body: string,
  headers?: Record<string, string>,
): APICallError {
  return new APICallError({
    message: body,
    url: 'https://example.test/v1',
    requestBodyValues: {},
    statusCode: status,
    responseBody: body,
    ...(headers ? { responseHeaders: headers } : {}),
  });
}

/* ── overflow text detection ─────────────────────────────────────────────── */
{
  check('overflow: "prompt is too long"', isContextOverflowText('prompt is too long: 250000 tokens'));
  check('overflow: tokens > maximum shape', isContextOverflowText('input length: 210000 tokens > 200000 maximum'));
  check('overflow: context_length_exceeded', isContextOverflowText('error: context_length_exceeded'));
  check('non-overflow: plain rate limit text', !isContextOverflowText('rate limit exceeded, slow down'));
  // Thinking-block 400 must NOT be read as overflow (else compaction loops on a 400).
  check(
    'thinking-block error is NOT overflow',
    !isContextOverflowText('messages.1: the first block must be a thinking block'),
  );
  check(
    'thinking-block "expected thinking" is NOT overflow',
    !isContextOverflowText('expected `thinking` but found `text`'),
  );
}

/* ── Retry-After parsing ─────────────────────────────────────────────────── */
{
  check('retry-after seconds → ms', parseRetryAfterMs('30') === 30_000);
  check('retry-after fractional seconds', parseRetryAfterMs('1.5') === 1500);
  check('retry-after empty → undefined', parseRetryAfterMs('') === undefined);
  check('retry-after garbage → undefined', parseRetryAfterMs('soon') === undefined);
  check('retry-after undefined → undefined', parseRetryAfterMs(undefined) === undefined);
  const future = new Date(Date.now() + 10_000).toUTCString();
  const ms = parseRetryAfterMs(future);
  check('retry-after HTTP-date (future) → ~10s', typeof ms === 'number' && ms > 8000 && ms <= 10_000);
  const past = new Date(Date.now() - 10_000).toUTCString();
  check('retry-after HTTP-date (past) → undefined', parseRetryAfterMs(past) === undefined);
  check('retry-after huge value is capped', parseRetryAfterMs('100000') === RETRY_AFTER_CAP_MS);
}

/* ── backoff schedule ────────────────────────────────────────────────────── */
{
  check('backoff attempt 0 = 1000', backoffDelayMs(0) === 1000);
  check('backoff attempt 1 = 2000', backoffDelayMs(1) === 2000);
  check('backoff attempt 3 = 8000', backoffDelayMs(3) === 8000);
  check('backoff is capped at 8000', backoffDelayMs(10) === 8000);
}

/* ── classification routing table ────────────────────────────────────────── */
{
  // 429 rate-limit (transient) → retry, with Retry-After honored.
  const rl = classifyStreamError(apiError(429, 'rate limit exceeded', { 'retry-after': '12' }));
  check('429 rate-limit → retry', rl.action === 'retry');
  check('429 carries Retry-After ms', rl.retryAfterMs === 12_000);

  // 429 quota EXHAUSTED → failover (a wait won't help).
  const quota = classifyStreamError(apiError(429, 'You exceeded your current quota, insufficient_quota'));
  check('429 quota-exhausted → failover', quota.action === 'failover');

  // 5xx server / overload → retry.
  check('500 → retry', classifyStreamError(apiError(500, 'internal error')).action === 'retry');
  check('529 overloaded → retry', classifyStreamError(apiError(529, 'overloaded_error')).action === 'retry');

  // Context overflow (arrives as 400) → compact.
  check(
    '400 overflow → compact',
    classifyStreamError(apiError(400, 'prompt is too long: 250000 tokens > 200000 maximum')).action === 'compact',
  );
  // Overflow that arrives as 413 → still compact (status-agnostic).
  check(
    '413 overflow → compact',
    classifyStreamError(apiError(413, 'request entity too large: context length exceeded')).action === 'compact',
  );

  // Auth → fatal.
  check('401 → fatal', classifyStreamError(apiError(401, 'invalid api key')).action === 'fatal');
  check('403 → fatal', classifyStreamError(apiError(403, 'forbidden')).action === 'fatal');

  // Plain bad-request (non-overflow) → fatal.
  check('400 bad request → fatal', classifyStreamError(apiError(400, 'invalid request: unknown field')).action === 'fatal');
  check('404 → fatal', classifyStreamError(apiError(404, 'no such model')).action === 'fatal');

  // Thinking-block structure 400 must be fatal, NOT compact.
  check(
    'thinking-block 400 → fatal (not compact)',
    classifyStreamError(apiError(400, 'messages.2: the first block must be a thinking block')).action === 'fatal',
  );

  // Network errors (non-APICallError) → retry.
  check('network ECONNRESET → retry', classifyStreamError(new Error('read ECONNRESET')).action === 'retry');
  check('network "fetch failed" → retry', classifyStreamError(new Error('fetch failed')).action === 'retry');
  check('timeout → retry', classifyStreamError(new Error('request timeout')).action === 'retry');

  // A plain non-network Error → fatal.
  check('plain Error → fatal', classifyStreamError(new Error('boom')).action === 'fatal');
  check('non-error value → fatal', classifyStreamError('nope').action === 'fatal');
}

console.log(`\n${passedCount()} checks passed`);
