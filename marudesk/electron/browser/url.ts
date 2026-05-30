/**
 * Address-bar / new-tab URL resolution. Pure and Electron-free so the policy is
 * unit-testable in isolation AND importable by both `navigation.ts` (the address
 * bar) and `tabs.ts` (new-tab / replace-tab initial loads) without a cycle —
 * `navigation.ts` imports `tabs.ts`, so the shared resolver has to live in a leaf.
 */

import type { SearchEngine } from '../../shared/settings';

/** Query-prefix per provider; `searchBaseFor` maps the setting → one of these. */
const SEARCH_BASES: Record<SearchEngine, string> = {
  google: 'https://www.google.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q=',
  bing: 'https://www.bing.com/search?q=',
};

/** The query-prefix for a configured search engine (defaults to Google). */
export function searchBaseFor(engine: SearchEngine): string {
  return SEARCH_BASES[engine] ?? SEARCH_BASES.google;
}

/**
 * Resolve raw address-bar input to a URL safe to load, or '' to ignore.
 * `searchBase` is the query prefix of the user's chosen search engine.
 *
 *  - http(s) and `about:blank` load as-is.
 *  - Any OTHER explicit scheme (file:, javascript:, data:, blob:, chrome:,
 *    devtools:, view-source:, other about:, ftp:) is NEVER loaded — it routes
 *    to a web search, so typing one can't execute script or reach local
 *    resources / browser internals.
 *  - Schemeless input that looks like host[:port][/path] (or localhost) becomes
 *    https://…; anything else becomes a web search.
 */
export function resolveAddressBarInput(
  rawInput: string,
  searchBase: string = SEARCH_BASES.google,
): string {
  const input = rawInput.trim();
  if (!input) return '';
  if (/^https?:\/\//i.test(input)) return input;
  if (input === 'about:blank') return input;
  // Refuse to load dangerous / internal schemes — fall through to a search.
  if (
    /^(file|javascript|data|blob|chrome|devtools|view-source|about|ftp):/i.test(
      input,
    )
  ) {
    return searchUrl(input, searchBase);
  }
  // Schemeless: looks like a host (has a dot/port/path) or localhost → https.
  if (/^[\w.-]+(:\d+)?(\/.*)?$/.test(input) || input.startsWith('localhost')) {
    return 'https://' + input;
  }
  return searchUrl(input, searchBase);
}

function searchUrl(query: string, base: string): string {
  return base + encodeURIComponent(query);
}
