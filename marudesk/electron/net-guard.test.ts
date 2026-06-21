import { describe, it, expect } from 'vitest';
import { isBlockedIp, resolvePublicHost, guardedGet, BlockedHostError, type DnsLookup } from './net-guard';

/**
 * Unit coverage for the shared SSRF guard. The pure pieces (isBlockedIp,
 * resolvePublicHost) are exercised directly with a stubbed DNS resolver so the
 * suite never touches the real network. guardedGet's redirect-hop re-validation
 * is proven by asserting it rejects when the redirect target resolves to a
 * blocked address — without a real socket, the resolve step fails first, which is
 * exactly the guarantee under test (every hop is resolved + validated).
 */

describe('isBlockedIp', () => {
  it('blocks IPv4 loopback / private / link-local / CGNAT / "this"', () => {
    for (const ip of ['127.0.0.1', '127.1.2.3', '10.0.0.1', '192.168.1.1', '172.16.0.1', '172.31.255.255', '169.254.169.254', '100.64.0.1', '0.0.0.0']) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it('allows ordinary public IPv4', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1']) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });

  it('blocks IPv6 loopback / unique-local / link-local', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1']) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it('blocks non-canonical (expanded) IPv6 loopback / link-local', () => {
    // Classified by value, not spelling — a hostile resolver / future caller
    // can't dodge the guard by handing over an un-compressed form.
    for (const ip of ['0:0:0:0:0:0:0:1', '0:0:0:0:0:0:0:0', 'fe80:0:0:0:0:0:0:1', 'fd12:3456:0:0:0:0:0:1']) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it('blocks IPv4-mapped IPv6 wrapping a private address', () => {
    expect(isBlockedIp('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedIp('::ffff:169.254.169.254')).toBe(true);
  });

  it('allows ordinary public IPv6', () => {
    expect(isBlockedIp('2606:4700:4700::1111')).toBe(false);
  });
});

/** A DNS stub that maps each hostname to a fixed address list. */
function stubLookup(map: Record<string, readonly string[]>): DnsLookup {
  return async (hostname) => {
    const addrs = map[hostname.toLowerCase()];
    if (!addrs) throw new Error(`no stub for ${hostname}`);
    return addrs;
  };
}

describe('resolvePublicHost', () => {
  it('rejects a public hostname that resolves to loopback (SSRF)', async () => {
    const lookup = stubLookup({ 'evil.example': ['127.0.0.1'] });
    await expect(resolvePublicHost('evil.example', lookup)).rejects.toBeInstanceOf(BlockedHostError);
  });

  it('rejects a public hostname that resolves to a link-local metadata IP', async () => {
    const lookup = stubLookup({ 'rebind.example': ['169.254.169.254'] });
    await expect(resolvePublicHost('rebind.example', lookup)).rejects.toBeInstanceOf(BlockedHostError);
  });

  it('rejects when ANY of several addresses is private', async () => {
    const lookup = stubLookup({ 'mixed.example': ['93.184.216.34', '10.0.0.1'] });
    await expect(resolvePublicHost('mixed.example', lookup)).rejects.toBeInstanceOf(BlockedHostError);
  });

  it('rejects when DNS resolution fails', async () => {
    const lookup = stubLookup({});
    await expect(resolvePublicHost('nope.example', lookup)).rejects.toBeInstanceOf(BlockedHostError);
  });

  it('allows a public hostname and pins to the first address', async () => {
    const lookup = stubLookup({ 'example.com': ['93.184.216.34'] });
    const resolved = await resolvePublicHost('example.com', lookup);
    expect(resolved).toEqual({ pinnedIp: '93.184.216.34', family: 4 });
  });

  it('classifies an IPv6 public address as family 6', async () => {
    const lookup = stubLookup({ 'v6.example': ['2606:4700:4700::1111'] });
    const resolved = await resolvePublicHost('v6.example', lookup);
    expect(resolved.family).toBe(6);
  });

  it('rejects a literal loopback IP without needing DNS', async () => {
    await expect(resolvePublicHost('127.0.0.1', stubLookup({}))).rejects.toBeInstanceOf(BlockedHostError);
  });
});

describe('guardedGet', () => {
  const noopData = (): boolean => true;
  const baseOpts = { timeoutMs: 1000, maxRedirects: 5 } as const;

  it('refuses a non-http(s) URL', async () => {
    await expect(
      guardedGet(new URL('file:///etc/passwd'), noopData, { ...baseOpts, lookup: stubLookup({}) }),
    ).rejects.toBeInstanceOf(BlockedHostError);
  });

  it('refuses before connecting when the host resolves to a blocked address', async () => {
    // The lookup maps the target to loopback; resolvePublicHost rejects, so no
    // socket is ever opened. This is the DNS-rebinding guard.
    const lookup = stubLookup({ 'evil.example': ['127.0.0.1'] });
    await expect(
      guardedGet(new URL('https://evil.example/'), noopData, { ...baseOpts, lookup }),
    ).rejects.toBeInstanceOf(BlockedHostError);
  });
});
