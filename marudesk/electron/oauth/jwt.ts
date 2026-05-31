/**
 * Minimal JWT payload decode — NO signature verification. We only read claims from
 * tokens we just obtained through our own OAuth exchange (so they're already
 * trusted); this is purely to pull metadata like the ChatGPT account id out of the
 * token. Never use this to make trust decisions about a third-party token.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length < 2) return {};
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
    const parsed: unknown = JSON.parse(Buffer.from(b64 + pad, 'base64').toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The ChatGPT account id from a Codex access/id token (or null). codex-cli reads
 * `payload["https://api.openai.com/auth"].chatgpt_account_id`; we also accept a
 * top-level `chatgpt_account_id` as a fallback. Sent as the `chatgpt-account-id`
 * header on codex backend requests.
 */
export function chatgptAccountId(token: string): string | null {
  const claims = decodeJwtPayload(token);
  const auth = claims['https://api.openai.com/auth'];
  if (auth && typeof auth === 'object') {
    const id = (auth as Record<string, unknown>).chatgpt_account_id;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  const top = claims.chatgpt_account_id;
  return typeof top === 'string' && top.length > 0 ? top : null;
}
