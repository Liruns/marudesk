import { execFileSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import type { ConnectCandidate } from '../../shared/remote';

/**
 * Reachable-URL discovery for the LAN/Tailscale bridge (T2 — docs/remote-mobile-
 * bridge-design §3 "Connection scope"). Once the server binds beyond loopback, the
 * phone must know WHICH address actually reaches this PC, and we can't know the
 * network topology from here. So — exactly like gronxb/codex-relay's
 * `pairing-url-candidates` — we enumerate every plausible base URL (Tailscale
 * first, then private LAN IPs), hand them ALL to the phone in the pairing QR, and
 * let the client try them in order and keep the first that connects.
 *
 * This module is intentionally pure + Electron-free (just `node:os` /
 * `node:child_process`) so it stays unit-testable and can't crash main: Tailscale
 * detection shells out best-effort with a short timeout and swallows every error
 * (no CLI / not logged in simply yields no Tailscale candidates).
 */

// {@link ConnectCandidate} lives in shared/remote.ts so the renderer (Settings UI)
// can render the same shape main computes here.
export type { ConnectCandidate };

/**
 * Collect reachable base-URL candidates for `port`: the user-configured public
 * URL first (a stable self-hosted tunnel/reverse proxy — it works from ANY
 * network, so it's the best first guess), then the managed auto-tunnel's URL,
 * then Tailscale, then private LAN addresses. De-duplicated by URL, order
 * preserved. Never throws.
 */
export function getConnectCandidates(
  port: number,
  publicUrl?: string,
  tunnelUrl?: string,
): ConnectCandidate[] {
  return dedupe([
    ...publicUrlCandidates('Public', publicUrl),
    ...publicUrlCandidates('Tunnel', tunnelUrl),
    ...tailscaleCandidates(port),
    ...lanCandidates(port),
  ]);
}

/** A from-anywhere base URL (Settings public URL / managed tunnel), normalized; '' = none. */
function publicUrlCandidates(label: string, raw?: string): ConnectCandidate[] {
  const url = raw?.trim().replace(/\/+$/, '');
  return url ? [{ label, url }] : [];
}

/** Tailscale IPs (100.64/10 + IPv6) and the MagicDNS name, if the CLI reports them. */
function tailscaleCandidates(port: number): ConnectCandidate[] {
  const status = tailscaleStatus();
  const out: ConnectCandidate[] = [];
  for (const ip of status?.Self?.TailscaleIPs ?? []) {
    // Prefer the IPv4 (100.x) — simplest to type/scan; skip IPv6 here.
    if (ip.includes('.')) out.push({ label: 'Tailscale', url: `http://${ip}:${port}` });
  }
  const dns = status?.Self?.DNSName?.replace(/\.$/, '');
  if (dns) out.push({ label: 'Tailscale DNS', url: `http://${dns}:${port}` });
  return out;
}

/** Every non-internal private IPv4 across the host's network interfaces. */
function lanCandidates(port: number): ConnectCandidate[] {
  const out: ConnectCandidate[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal && isPrivateV4(a.address)) {
        out.push({ label: name, url: `http://${a.address}:${port}` });
      }
    }
  }
  return out;
}

/** RFC1918 private IPv4 (10/8, 172.16/12, 192.168/16) — what a LAN actually hands out. */
function isPrivateV4(host: string): boolean {
  const o = host.split('.').map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return (
    o[0] === 10 ||
    (o[0] === 172 && o[1] >= 16 && o[1] <= 31) ||
    (o[0] === 192 && o[1] === 168)
  );
}

/** Best-effort `tailscale status --json`. Returns undefined if the CLI is absent/down. */
function tailscaleStatus(): { Self?: { DNSName?: string; TailscaleIPs?: string[] } } | undefined {
  try {
    const out = execFileSync('tailscale', ['status', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    });
    return JSON.parse(out) as { Self?: { DNSName?: string; TailscaleIPs?: string[] } };
  } catch {
    // No Tailscale CLI, not running, or not logged in — fine, just no candidates.
    return undefined;
  }
}

/** De-dupe candidates by URL, preserving first-seen order. */
function dedupe(cands: ConnectCandidate[]): ConnectCandidate[] {
  const seen = new Map<string, ConnectCandidate>();
  for (const c of cands) if (!seen.has(c.url)) seen.set(c.url, c);
  return [...seen.values()];
}
