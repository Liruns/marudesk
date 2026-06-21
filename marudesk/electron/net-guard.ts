import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

/**
 * Shared SSRF guard for the host's outbound HTTP(S) callers (the agent's
 * `fetch_url` tool and the plugin runtime's `ctx.http.fetch`). It exists once,
 * here under electron/ (it uses node dns/net/tls/http(s), so it can NOT live in
 * shared/), so both callers enforce the SAME defense instead of one path doing
 * literal-hostname checks and the other doing real resolution.
 *
 * The guarantee: for every hostname we connect to — including each redirect hop
 * — we resolve ALL of its addresses, reject if ANY is private / loopback /
 * link-local / cloud-metadata, and then PIN the socket to a validated IP while
 * still presenting the hostname as TLS SNI + Host header. Pinning closes the
 * DNS-rebinding (TOCTOU) window where a hostile authoritative server hands the
 * check a public IP and the actual connect a private one.
 */

/** Reject an IP literal that is private / loopback / link-local / CGNAT / metadata. */
export function isBlockedIp(ip: string): boolean {
  const bare = ip.replace(/^::ffff:/i, ''); // unwrap IPv4-mapped IPv6
  const v = net.isIP(bare);
  if (v === 4) {
    const [a, b] = bare.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true; // "this" / private / loopback
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (v === 6) {
    // Classify numerically so non-canonical forms (expanded loopback
    // `0:0:0:0:0:0:0:1`, expanded link-local) can't slip past a string match —
    // this is an exported, reusable guard, so it must not depend on the caller
    // having canonicalized the address first.
    const n = v6ToBigInt(bare);
    if (n === null) return true; // unparseable v6 → fail closed
    if (n === 0n || n === 1n) return true; // :: (unspecified) / ::1 (loopback)
    const top16 = n >> 112n;
    if ((top16 & 0xffc0n) === 0xfe80n) return true; // fe80::/10 link-local
    if ((top16 & 0xfe00n) === 0xfc00n) return true; // fc00::/7 unique-local
    return false;
  }
  // net.isIP returned 0 — the original had an IPv4-mapped prefix but the
  // remainder isn't a valid IP. Treat anything we can't classify as blocked.
  return ip.toLowerCase().startsWith('::ffff:');
}

/** Parse any textual IPv6 (compressed or expanded) to its 128-bit value, or null
 *  if malformed. Used so {@link isBlockedIp} classifies by value, not by spelling. */
function v6ToBigInt(addr: string): bigint | null {
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups: string[];
  if (halves.length === 2) {
    const fill = 8 - (head.length + tail.length);
    if (fill < 1) return null; // "::" must stand in for at least one group
    groups = [...head, ...Array<string>(fill).fill('0'), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  let val = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null; // (no embedded-IPv4 tail: unwrapped earlier)
    val = (val << 16n) | BigInt(parseInt(g, 16));
  }
  return val;
}

/** Injectable DNS resolver (kept narrow so tests can stub it without real DNS). */
export type DnsLookup = (hostname: string) => Promise<readonly string[]>;

const realLookup: DnsLookup = async (hostname) =>
  (await dns.lookup(hostname, { all: true })).map((a) => a.address);

/** A hostname resolved to a set of addresses, with one chosen to pin the socket to. */
export type ResolvedHost = {
  /** The address we connect to (already validated, ::ffff: unwrapped). */
  readonly pinnedIp: string;
  /** IP family of {@link pinnedIp}, for the http(s) request `family` option. */
  readonly family: 4 | 6;
};

/** Thrown when a host is refused (non-public address, or could not resolve). */
export class BlockedHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedHostError';
  }
}

/**
 * Resolve a hostname, reject if it (or any of its addresses) is non-public, and
 * return a single validated IP to pin the connection to. Throws
 * {@link BlockedHostError} on resolution failure or a blocked address.
 */
export async function resolvePublicHost(hostname: string, lookup: DnsLookup = realLookup): Promise<ResolvedHost> {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  // A bare IP literal still has to clear the block list (no DNS needed).
  if (net.isIP(host) !== 0) {
    if (isBlockedIp(host)) throw new BlockedHostError(`"${hostname}" is a non-public address`);
    const bare = host.replace(/^::ffff:/i, '');
    return { pinnedIp: bare, family: bare.includes(':') ? 6 : 4 };
  }
  let addrs: readonly string[];
  try {
    addrs = await lookup(host);
  } catch {
    throw new BlockedHostError(`could not resolve "${hostname}"`);
  }
  if (addrs.length === 0 || addrs.some((ip) => isBlockedIp(ip))) {
    throw new BlockedHostError(`"${hostname}" resolves to a non-public address`);
  }
  const pinned = addrs[0].replace(/^::ffff:/i, '');
  return { pinnedIp: pinned, family: pinned.includes(':') ? 6 : 4 };
}

/** A response body chunk arrived; return false to stop reading (size cap hit). */
export type OnData = (chunk: Buffer) => boolean;

/** Options controlling one guarded GET; defaults match a conservative caller. */
export type GuardedGetOptions = {
  /** Extra request headers (merged over Host, which the helper always sets). */
  readonly headers?: Record<string, string>;
  /** Per-request socket timeout in ms. */
  readonly timeoutMs: number;
  /** Max redirect hops to follow; 0 means "return the 3xx as-is". */
  readonly maxRedirects: number;
  /** Abort the request when this signal fires. */
  readonly signal?: AbortSignal;
  /** Inject a DNS resolver (tests only); defaults to the real one. */
  readonly lookup?: DnsLookup;
};

/** The raw result of a guarded GET, before any caller-specific decoding. */
export type GuardedGetResult = {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: Buffer;
  /** The URL actually fetched (the last hop after any redirects). */
  readonly finalUrl: string;
};

/**
 * GET a URL with the full SSRF guard: validate + pin the host, connect by IP with
 * hostname SNI/Host, follow redirects up to `maxRedirects` (re-validating every
 * hop), and buffer the body subject to `onData`'s size policy. Throws
 * {@link BlockedHostError} for a refused host and a plain Error for transport
 * failures. The body is whatever `onData` accepted, concatenated.
 */
export async function guardedGet(
  rawUrl: URL,
  onData: OnData,
  opts: GuardedGetOptions,
): Promise<GuardedGetResult> {
  const lookup = opts.lookup ?? realLookup;
  let url = rawUrl;
  let redirectsLeft = opts.maxRedirects;
  // Iterate hops rather than recurse so the size/timeout policy stays uniform.
  for (;;) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new BlockedHostError('only http(s) URLs are allowed');
    }
    const resolved = await resolvePublicHost(url.hostname, lookup);
    const hop = await connectOnce(url, resolved, onData, opts);
    if (hop.kind === 'redirect') {
      if (redirectsLeft <= 0) throw new Error('Too many redirects.');
      redirectsLeft -= 1;
      url = hop.location;
      continue;
    }
    return hop.result;
  }
}

type Hop =
  | { kind: 'redirect'; location: URL }
  | { kind: 'response'; result: GuardedGetResult };

/** One pinned GET; resolves to a redirect target or a buffered response. */
function connectOnce(
  url: URL,
  resolved: ResolvedHost,
  onData: OnData,
  opts: GuardedGetOptions,
): Promise<Hop> {
  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? https : http;
  const port = url.port ? Number(url.port) : isHttps ? 443 : 80;
  return new Promise<Hop>((resolve, reject) => {
    let settled = false;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const req = lib.request(
      {
        host: resolved.pinnedIp,
        family: resolved.family,
        port,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { ...opts.headers, Host: url.host },
        // TLS SNI + cert validation target the real hostname, not the pinned IP.
        ...(isHttps ? { servername: url.hostname } : {}),
        signal: opts.signal,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        // Only treat a 3xx as a hop to follow when redirects are allowed; with
        // maxRedirects === 0 the caller wants the 3xx returned verbatim (so a
        // redirect can never bounce the connection to a not-yet-validated host).
        if (opts.maxRedirects > 0 && status >= 300 && status < 400 && res.headers.location) {
          res.resume(); // drain
          let next: URL;
          try {
            next = new URL(res.headers.location, url);
          } catch {
            return fail(new BlockedHostError('Invalid redirect location.'));
          }
          if (settled) return;
          settled = true;
          resolve({ kind: 'redirect', location: next });
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          if (settled) return;
          if (!onData(chunk)) {
            // Size cap hit: settle with what we've buffered so far, THEN end the
            // response. (Destroying without resolving would leave the promise
            // pending forever — `res.destroy()` with no error fires only 'close',
            // which we don't listen for.) Callers either truncate this body to
            // their byte budget or treat the cap as an oversize error.
            settled = true;
            resolve({
              kind: 'response',
              result: { status, headers: res.headers, body: Buffer.concat(chunks), finalUrl: url.href },
            });
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          resolve({
            kind: 'response',
            result: { status, headers: res.headers, body: Buffer.concat(chunks), finalUrl: url.href },
          });
        });
        res.on('error', (err) => fail(err));
      },
    );
    req.setTimeout(opts.timeoutMs, () => {
      fail(new Error('Request timed out.'));
      req.destroy();
    });
    req.on('error', (err) => fail(err));
    req.end();
  });
}
