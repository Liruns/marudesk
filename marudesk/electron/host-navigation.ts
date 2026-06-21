/**
 * The HOST renderer is privileged: it runs the preload bridge under a `'self'`
 * CSP and is the single trusted document. Any `will-navigate` it attempts must
 * therefore be pinned to the EXACT entry URL the window loaded — never the bare
 * `file://` scheme. Pinning to the scheme would let the privileged renderer
 * navigate to ANY local file (e.g. attacker-controlled HTML on disk), escaping
 * the single-document boundary. Only same-document navigations (hash/query on
 * the entry document) are also allowed, since those re-render the same app.
 */

/**
 * Decide whether the host renderer may navigate to `targetUrl` given the
 * `entryUrl` the window actually loaded. Pure + total: any unparseable input
 * is rejected. Allowed iff the target is the entry document itself — same
 * origin and same pathname — regardless of differing hash/search. Everything
 * else (a different `file://` path, an `http(s)` URL, a custom scheme) is
 * rejected and should be routed through the external-URL opener by the caller.
 */
export function isAllowedHostNavigation(targetUrl: string, entryUrl: string): boolean {
  let target: URL;
  let entry: URL;
  try {
    target = new URL(targetUrl);
    entry = new URL(entryUrl);
  } catch {
    return false;
  }
  // Same-document only: identical origin + pathname. `hash`/`search` may differ
  // (client-side routing, deep links) but the document on disk must be the one
  // we loaded. `origin` covers scheme + host (`file://` host is empty).
  return target.origin === entry.origin && target.pathname === entry.pathname;
}
