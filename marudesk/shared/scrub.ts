/**
 * Secret/PII scrubbing for any page-originated text that travels to an LLM —
 * network bodies/headers, `eval_js` results, console messages (roadmap P0.5:
 * "전송 전 secret scrub이 전제조건"). Pure (no imports), so it is unit-testable
 * (e2e/scrub.spec.ts) and shared between main (the agent tool executors) and the
 * renderer (if it ever previews outbound context).
 *
 * Philosophy: redact aggressively on *recognized* secret shapes (tokens, keys,
 * auth headers, `key=value` pairs whose key looks sensitive) rather than trying
 * to entropy-detect everything — false negatives on novel formats are accepted,
 * but a recognized credential must never leave the machine in cleartext. All
 * regexes are linear-time (no nested unbounded quantifiers) so a hostile page
 * body can't cause catastrophic backtracking.
 */

export const REDACTED = '«redacted»';

/** Header names whose *entire* value is replaced (case-insensitive). */
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'x-amz-security-token',
  'x-csrf-token',
  'x-xsrf-token',
  'x-access-token',
]);

/**
 * Token-shaped secrets, matched anywhere in free text. Order matters only for
 * readability — each pattern is independent and replaces the whole match.
 */
const TOKEN_PATTERNS: RegExp[] = [
  // JSON Web Tokens (three base64url segments).
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
  // OpenAI / Anthropic style: sk-..., sk-ant-...
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g,
  // Google API keys.
  /\bAIza[A-Za-z0-9_-]{16,}/g,
  // AWS access key IDs.
  /\bA(?:KIA|SIA|GPA|IDA|ROA)[A-Z0-9]{12,}/g,
  // GitHub tokens (ghp_/gho_/ghu_/ghs_/ghr_/github_pat_).
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  // Slack tokens.
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  // Google OAuth refresh / Stripe-ish / generic long secret prefixes.
  /\b(?:ya29|AIzaSy|sk_live|sk_test|rk_live|pk_live)[A-Za-z0-9_-]{10,}/g,
];

// `Authorization: Bearer <token>` and bare `Bearer <token>` — keep the scheme,
// redact the credential.
const BEARER = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

// `"api_key": "…"`, `password=…`, `secret: …` — redact the value, keep the key
// so the shape stays legible to the model. The value half is bounded to a single
// token (stops at quote / comma / brace / whitespace / ampersand).
const KV_SECRET =
  /("?\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd|pwd|authorization|auth[_-]?token|session[_-]?token|private[_-]?key)\b"?\s*[:=]\s*)("?)([^"&\s,}{]{4,})\2/gi;

// Emails (PII). Mask the local part, keep the domain so error context stays
// useful ("user@acme.com" → "«redacted»@acme.com").
const EMAIL = /\b[A-Za-z0-9._%+-]+(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;

/**
 * Redact recognized secrets/PII from a free-text string. Idempotent and
 * total — never throws, returns '' for non-strings (defensive: page data).
 */
export function scrubText(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0) {
    return typeof input === 'string' ? input : '';
  }
  let out = input;
  for (const re of TOKEN_PATTERNS) out = out.replace(re, REDACTED);
  out = out.replace(BEARER, (_m, scheme: string) => `${scheme} ${REDACTED}`);
  out = out.replace(KV_SECRET, (_m, prefix: string, q: string) => `${prefix}${q}${REDACTED}${q}`);
  out = out.replace(EMAIL, (_m, domain: string) => `${REDACTED}${domain}`);
  return out;
}

/**
 * Redact a header map: sensitive header values become {@link REDACTED} wholesale;
 * everything else is still run through {@link scrubText} (a stray token can ride
 * in a custom header). Accepts the loose `Record<string, string>` CDP reports.
 */
export function scrubHeaders(
  headers: Record<string, string> | undefined | null,
): Record<string, string> {
  if (!headers || typeof headers !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v !== 'string') continue;
    out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? REDACTED : scrubText(v);
  }
  return out;
}
