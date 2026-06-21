/**
 * DNS-rebinding guard for the loopback companion (router.ts handleRequest).
 *
 * The companion binds 127.0.0.1 on an ephemeral port and gates every route on a
 * constant-time bearer. The bearer stops outright theft, but a DNS-rebinding page
 * (an attacker domain re-resolved to 127.0.0.1:<port>) can still issue same-origin
 * requests from the victim's browser. Validating the `Host` header against a
 * loopback allow-list closes that vector: a rebinding request carries the attacker's
 * hostname in `Host`, not a loopback literal, so it is rejected before any work.
 *
 * Pure + node-builtin-free so it can live next to the router and be unit-tested
 * headlessly.
 */

/** The host names we accept (host portion only, case-insensitive). */
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Split a `Host` header into its host portion and optional port. The header is
 * either `host` or `host:port`; an IPv6 literal is bracketed (`[::1]` /
 * `[::1]:port`). Returns null for a malformed value.
 */
function splitHostHeader(hostHeader: string): { host: string; port: string | null } | null {
  const trimmed = hostHeader.trim();
  if (trimmed === '') return null;

  // Bracketed IPv6 literal: `[::1]` or `[::1]:port`.
  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']');
    if (close === -1) return null;
    const host = trimmed.slice(0, close + 1); // keep the brackets
    const rest = trimmed.slice(close + 1);
    if (rest === '') return { host, port: null };
    if (rest.startsWith(':')) return { host, port: rest.slice(1) };
    return null;
  }

  // host or host:port — a second colon would be a bare IPv6 literal (invalid here).
  const firstColon = trimmed.indexOf(':');
  if (firstColon === -1) return { host: trimmed, port: null };
  const host = trimmed.slice(0, firstColon);
  const port = trimmed.slice(firstColon + 1);
  if (host === '' || port.includes(':')) return null;
  return { host, port };
}

/**
 * True when the request's `Host` header names a loopback host and (if it carries
 * a port) that port matches the companion's bound port. Rejects missing/empty
 * headers and any non-loopback host — the DNS-rebinding case.
 *
 * @param hostHeader the raw `Host` header (`req.headers.host`), or undefined.
 * @param port the companion's actual bound port (`req.socket.localPort`).
 */
export function isAllowedCompanionHost(hostHeader: string | undefined, port: number): boolean {
  if (typeof hostHeader !== 'string') return false;
  const parts = splitHostHeader(hostHeader);
  if (parts === null) return false;
  if (!ALLOWED_HOSTS.has(parts.host.toLowerCase())) return false;
  // A port in the header must match the listener; a portless Host (default :80)
  // can't reach an ephemeral-port companion in a browser, but accept it so a
  // hand-crafted loopback client isn't gratuitously rejected.
  if (parts.port !== null && parts.port !== String(port)) return false;
  return true;
}
