/**
 * Pure derivation helpers for the Network detail pane (no React, no store):
 * query-string / form-body parsing for the Headers tab's payload sections.
 * Follows the console/completion.ts precedent of keeping store-free domain
 * logic in its own module.
 */

/** Parse a request URL's query string into ordered [key, value] pairs. */
export function parseQueryParams(url: string): [string, string][] {
  try {
    return [...new URL(url).searchParams.entries()];
  } catch {
    return [];
  }
}

/**
 * Parse a form-encoded request body into [key, value] pairs, or null when the
 * content type isn't `application/x-www-form-urlencoded` (the caller falls back
 * to JSON pretty-print / raw).
 */
export function parseFormBody(
  body: string,
  contentType: string | undefined,
): [string, string][] | null {
  if (!contentType || !/application\/x-www-form-urlencoded/i.test(contentType)) return null;
  try {
    return [...new URLSearchParams(body).entries()];
  } catch {
    return null;
  }
}
