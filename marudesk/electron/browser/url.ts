/**
 * Address-bar / new-tab URL resolution. Pure and Electron-free so the policy is
 * unit-testable in isolation AND importable by both `navigation.ts` (the address
 * bar) and `tabs.ts` (new-tab / replace-tab initial loads) without a cycle —
 * `navigation.ts` imports `tabs.ts`, so the shared resolver has to live in a leaf.
 *
 * The schemeless host-vs-search decision is backed by the Public Suffix List
 * (via `tldts`), ported from the `pane` browser's omnibox contract
 * (reference/pane/DESIGN.md §10, src/renderer/features/url-parser.js): a dotted
 * token loads only when its public suffix is a real ICANN TLD, so `file.txt`,
 * `1.5`, and `foo.invalidtld` fall through to search instead of over-navigating.
 */

import { parse as parseDomain } from 'tldts';
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
 * Tokens that look like hosts (a real TLD) but are almost always a search — a
 * library / package name. Ambiguity yields to search, never an auto-load
 * (pane DESIGN §10.4); the `.io` in `socket.io` is a real TLD, but the user
 * means the project, not the website.
 */
const PACKAGE_DENYLIST = new Set([
  'socket.io', 'node.js', 'vue.js', 'next.js', 'nuxt.js', 'three.js',
  'd3.js', 'react.js', 'angular.js', 'ember.js', 'express.js', 'jquery.js',
]);

function isIPv4(host: string): boolean {
  const parts = host.split('.');
  return (
    parts.length === 4 &&
    parts.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}

/**
 * True when `host`'s public suffix is a real, ICANN-delegated TLD per the PSL —
 * i.e. the dotted token is a navigable domain, not a filename (`file.txt`), a
 * decimal (`1.5`), a reserved label (`.test`, `.local`), or a typo'd TLD
 * (`foo.invalidtldxyz`). `isIcann` is load-bearing: tldts otherwise treats any
 * trailing label as a "suffix", so a bare suffix-exists check would over-load.
 * Multi-level suffixes (`co.uk`) and IDN/punycode are handled inside tldts.
 */
function isRegistrableHost(host: string): boolean {
  if (!host) return false;
  return parseDomain(host).isIcann === true;
}

function canParseUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
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
 *  - Loopback / IP / IPv6 hosts load on http:// (https:// only for `:443`), so
 *    dev servers (`localhost:5173`, `127.0.0.1:8000`) work without a manual
 *    scheme.
 *  - A bare dotted host loads only when its public suffix is a real TLD (PSL)
 *    and it isn't a package-name token; public domains keep https://, but an
 *    explicit non-443 port marks a dev server → http://.
 *  - Single-label tokens (`jira`), prose, and ambiguous tokens become a search.
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

  // Schemeless from here. Split host[:port] off any /path, ?query, or #fragment.
  const hostPort = input.split(/[/?#]/)[0];

  // Bare (unbracketed) IPv6 — 2+ colons ARE the address, not a port (a port on
  // IPv6 needs brackets), so wrap the whole host. e.g. `::1`, `2001:db8::1`.
  if (!hostPort.includes('[') && (hostPort.match(/:/g) ?? []).length >= 2) {
    const v6 = 'http://[' + hostPort + ']' + input.slice(hostPort.length);
    if (canParseUrl(v6)) return v6;
  }

  const portMatch = hostPort.match(/:(\d+)$/);
  const host = portMatch ? hostPort.slice(0, -portMatch[0].length) : hostPort;
  // With an explicit port, `:443` ⇒ https, else http (dev-server convention).
  // No port ⇒ defer to the caller below (http for loopback, https for the web).
  const portProto = portMatch
    ? portMatch[1] === '443'
      ? 'https://'
      : 'http://'
    : null;

  // Loopback / IPv4 / bracketed IPv6 [:port][/path] → load on http (https :443).
  if (/^localhost$/i.test(host) || /\.localhost$/i.test(host)) {
    return (portProto ?? 'http://') + input;
  }
  if (/^\[[0-9a-f:]+\]$/i.test(host)) return (portProto ?? 'http://') + input;
  if (isIPv4(host)) return (portProto ?? 'http://') + input;

  // Bare host with a dot → load only when the public suffix is a real TLD and
  // the token isn't a known package name; otherwise search.
  if (!/\s/.test(input) && host.includes('.')) {
    if (PACKAGE_DENYLIST.has(host.toLowerCase())) return searchUrl(input, searchBase);
    const probe = 'https://' + input;
    if (canParseUrl(probe) && isRegistrableHost(new URL(probe).hostname)) {
      return (portProto ?? 'https://') + input;
    }
  }

  // Single-label host, prose, or a denylisted/unresolvable token → search.
  return searchUrl(input, searchBase);
}

function searchUrl(query: string, base: string): string {
  return base + encodeURIComponent(query);
}

/**
 * The direct-navigation target to surface as a "Go to <host>" address-bar
 * suggestion, or null when the input is only a web search. Returns the resolved
 * URL when the input loads (host / IP / localhost / PSL domain), AND — matching
 * pane's omnibox (reference/pane suggestions.js `actions`) — `https://<host>`
 * for a dotted, whitespace-free, PSL-valid token that DEFAULTED to search (e.g.
 * a denylisted package name like `socket.io`), so the user can still navigate it
 * in one click even though Enter would search. Pure, so it's unit-testable.
 */
export function addressNavTarget(
  rawInput: string,
  searchBase: string = SEARCH_BASES.google,
): string | null {
  const resolved = resolveAddressBarInput(rawInput, searchBase);
  if (resolved && resolved !== 'about:blank' && !resolved.startsWith(searchBase)) {
    return resolved; // the input loads a real destination
  }
  // Searched — but a dotted, PSL-valid host (denylist case) can still be a Go-to.
  const input = rawInput.trim();
  if (!/\s/.test(input) && input.includes('.')) {
    const probe = 'https://' + input;
    if (canParseUrl(probe) && isRegistrableHost(new URL(probe).hostname)) {
      return probe;
    }
  }
  return null;
}
