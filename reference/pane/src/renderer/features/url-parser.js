// Smart address parsing — DESIGN.md §10. Pure function (no DOM/IPC), unit-testable.
// Uses the URL API for IDN→punycode + validation, and the Public Suffix List (lib/host.js,
// backed by the vendored tldts bundle) to decide whether a dotted token is a real host or a
// search. A dotted host that turns out dead is still rescued by the custom error page's
// "Search instead".
import { isRegistrableHost } from '../lib/host.js';

export const SEARCH_BASE = 'https://www.google.com/search?q=';
export const search = (q) => SEARCH_BASE + encodeURIComponent(q);

// Tokens that look like hosts but are usually a search — a real TLD, but a library/package.
// Ambiguity yields to search + a "Go to" suggestion, never auto-load (DESIGN §10.4).
export const PACKAGE_DENYLIST = new Set([
  'socket.io', 'node.js', 'vue.js', 'next.js', 'nuxt.js', 'three.js',
  'd3.js', 'react.js', 'angular.js', 'ember.js', 'express.js', 'jquery.js',
]);

const isIPv4 = (h) => {
  const parts = h.split('.');
  return parts.length === 4 && parts.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255);
};

/**
 * Resolve raw omnibox input to a URL to load, or a search URL.
 * @returns {string|null} url to load, or null for empty input.
 */
export function toNavURL(raw) {
  const s = raw.trim();
  if (!s) return null;

  // about: — only about:blank is navigable from the omnibox
  if (/^about:/i.test(s)) return /^about:blank$/i.test(s) ? 'about:blank' : search(s);

  // Windows path → file URL (C:\dir\file.html or C:/dir)
  if (/^[a-z]:[\\/]/i.test(s)) return 'file:///' + s.replace(/\\/g, '/');

  // explicit scheme → load as-is (never re-prefix). Unknown schemes typed as text → search.
  const scheme = s.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (scheme) {
    const proto = scheme[1].toLowerCase();
    if ((proto === 'http' || proto === 'https' || proto === 'file' || proto === 'pane') && URL.canParse(s)) return s;
    return search(s);
  }

  const hostPort = s.split(/[/?#]/)[0];

  // bare IPv6 (unbracketed): 2+ colons and no brackets — the colons ARE the address, not a
  // port (a port on IPv6 requires brackets), so wrap the whole host. DESIGN §10.3.
  if (!hostPort.includes('[') && (hostPort.match(/:/g) || []).length >= 2) {
    const v6 = 'http://[' + hostPort + ']';
    if (URL.canParse(v6)) return v6 + s.slice(hostPort.length);
  }

  const host = hostPort.replace(/:\d+$/, '');
  const proto = /:443$/.test(hostPort) ? 'https://' : 'http://'; // DESIGN §10: :443 ⇒ https

  // loopback / IP / bracketed IPv6 [:port][/path]
  if (/^localhost$/i.test(host)) return proto + s;
  if (/^\[[0-9a-f:]+\]$/i.test(host)) return proto + s;         // [::1], [2001:db8::1]
  if (isIPv4(host)) return proto + s;

  // bare host with a dot → load only if the public suffix is a real TLD (DESIGN §10.4).
  if (!/\s/.test(s) && host.includes('.')) {
    // "looks-like-a-package" tokens resolve to search, never auto-load.
    if (PACKAGE_DENYLIST.has(host.toLowerCase())) return search(s);
    if (URL.canParse(proto + s)) {
      const hostname = new URL(proto + s).hostname; // IDN → punycode
      if (isRegistrableHost(hostname)) return proto + s; // honor :443⇒https, else http (dev servers) — DESIGN §10.3
    }
  }

  // single-label or free text → search (no synchronous DNS; "Go to" suggestion is a follow-up)
  return search(s);
}
