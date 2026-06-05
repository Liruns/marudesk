import type { IncomingMessage } from 'node:http';

/**
 * Extract a Bearer token from a request's `Authorization` header (case-insensitive
 * scheme), or null when absent/malformed. Shared by the HTTP router and the
 * WebSocket upgrade path so the parsing rule stays in one place.
 */
export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const m = /^Bearer\s+(\S.*)$/i.exec(header);
  return m ? m[1]!.trim() : null;
}
