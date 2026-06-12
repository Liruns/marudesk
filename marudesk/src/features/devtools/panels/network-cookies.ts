/**
 * Pure parsers for the Network detail pane's Cookies tab: the request `Cookie`
 * header → name/value pairs, and the response `Set-Cookie` header → cookies
 * with their attributes. No React, no store — string in, rows out (tested in
 * network-cookies.test.ts).
 */

export type RequestCookie = { name: string; value: string };

/** One `Set-Cookie` attribute; flag attributes (`Secure`, `HttpOnly`) have no value. */
export type SetCookieAttribute = { name: string; value?: string };

export type ResponseCookie = {
  name: string;
  value: string;
  attributes: SetCookieAttribute[];
};

/**
 * Parse a request `Cookie` header (`a=1; b=2`) into name/value rows. A bare
 * token without `=` (technically invalid, seen in the wild) becomes a row with
 * an empty value rather than being dropped.
 */
export function parseCookieHeader(header: string | undefined): RequestCookie[] {
  if (!header) return [];
  const out: RequestCookie[] = [];
  for (const part of header.split(';')) {
    const pair = part.trim();
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      out.push({ name: pair, value: '' });
    } else {
      out.push({ name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim() });
    }
  }
  return out;
}

/**
 * Parse a response `Set-Cookie` header into cookies with attributes. CDP folds
 * multiple `Set-Cookie` headers into ONE header value joined by `\n` (the only
 * header it treats that way, because cookie values may contain commas), so each
 * line is one cookie: `name=value; Attr=v; Flag`.
 */
export function parseSetCookieHeader(header: string | undefined): ResponseCookie[] {
  if (!header) return [];
  const out: ResponseCookie[] = [];
  for (const line of header.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    const segments = text.split(';');
    const first = segments[0].trim();
    const eq = first.indexOf('=');
    if (eq <= 0) continue; // not a valid name=value cookie pair
    const cookie: ResponseCookie = {
      name: first.slice(0, eq).trim(),
      value: first.slice(eq + 1).trim(),
      attributes: [],
    };
    for (const segment of segments.slice(1)) {
      const attr = segment.trim();
      if (!attr) continue;
      const aeq = attr.indexOf('=');
      if (aeq <= 0) {
        cookie.attributes.push({ name: attr });
      } else {
        cookie.attributes.push({
          name: attr.slice(0, aeq).trim(),
          value: attr.slice(aeq + 1).trim(),
        });
      }
    }
    out.push(cookie);
  }
  return out;
}
