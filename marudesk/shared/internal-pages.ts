/**
 * The `maru://` internal-page rail — marudesk's take on pane's `pane://` pages
 * (reference/pane README, "pane:// internal pages"). The browser stage serves
 * two real, addressable documents over a privileged scheme: a new-tab start
 * page and a custom load-error page. The HTML itself lives main-side
 * (electron/browser/internal-pages.ts); THIS module is the transport-safe
 * contract shared by main, renderer, and tests — the scheme name, URL
 * builders/parsers, and the address-bar display mapping.
 */

export const INTERNAL_SCHEME = 'maru';
export const INTERNAL_NEWTAB_URL = `${INTERNAL_SCHEME}://newtab`;
const INTERNAL_ERROR_PREFIX = `${INTERNAL_SCHEME}://error`;

export type InternalErrorInfo = {
  /** The URL the navigation tried (and failed) to reach. */
  readonly failedUrl: string;
  /** Chromium net error code (e.g. -105 = NAME_NOT_RESOLVED); 0 if unknown. */
  readonly code: number;
  /** Chromium's error description (e.g. "ERR_NAME_NOT_RESOLVED"). */
  readonly description: string;
};

/** Build the error-page URL for a failed navigation (params are URL-encoded). */
export function buildInternalErrorUrl(info: InternalErrorInfo): string {
  const params = new URLSearchParams({
    url: info.failedUrl,
    code: String(info.code),
    description: info.description,
  });
  return `${INTERNAL_ERROR_PREFIX}?${params.toString()}`;
}

/** Parse a `maru://error?...` URL back to its info, or null if it isn't one. */
export function parseInternalErrorUrl(url: string): InternalErrorInfo | null {
  if (!url.startsWith(INTERNAL_ERROR_PREFIX)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return {
    failedUrl: parsed.searchParams.get('url') ?? '',
    code: Number(parsed.searchParams.get('code') ?? '0') || 0,
    description: parsed.searchParams.get('description') ?? '',
  };
}

/** True for any `maru://` internal page (new tab, error, …). */
export function isInternalUrl(url: string): boolean {
  return url.startsWith(`${INTERNAL_SCHEME}://`);
}

/**
 * The string to SHOW for a live tab URL — in the address bar and the tab strip,
 * and what to persist in a saved session. Internal new-tab / about:blank read as
 * empty (a clean new tab); the error page reads as the URL the user actually
 * tried to reach, so they can edit and retry it. Everything else is unchanged.
 */
export function displayUrl(url: string): string {
  if (!url || url === 'about:blank' || url === INTERNAL_NEWTAB_URL) return '';
  const err = parseInternalErrorUrl(url);
  if (err) return err.failedUrl;
  return url;
}
