import { describe, expect, it } from 'vitest';
import { isAllowedCompanionHost } from './host-allowlist';

const PORT = 52114;

describe('isAllowedCompanionHost', () => {
  it('accepts loopback hosts without a port', () => {
    expect(isAllowedCompanionHost('127.0.0.1', PORT)).toBe(true);
    expect(isAllowedCompanionHost('localhost', PORT)).toBe(true);
    expect(isAllowedCompanionHost('[::1]', PORT)).toBe(true);
  });

  it('accepts loopback hosts with the bound port', () => {
    expect(isAllowedCompanionHost(`127.0.0.1:${PORT}`, PORT)).toBe(true);
    expect(isAllowedCompanionHost(`localhost:${PORT}`, PORT)).toBe(true);
    expect(isAllowedCompanionHost(`[::1]:${PORT}`, PORT)).toBe(true);
  });

  it('is case-insensitive on the host portion', () => {
    expect(isAllowedCompanionHost('LocalHost', PORT)).toBe(true);
    expect(isAllowedCompanionHost(`LOCALHOST:${PORT}`, PORT)).toBe(true);
  });

  it('tolerates surrounding whitespace', () => {
    expect(isAllowedCompanionHost(`  127.0.0.1:${PORT}  `, PORT)).toBe(true);
  });

  it('rejects a port that does not match the listener', () => {
    expect(isAllowedCompanionHost(`127.0.0.1:${PORT + 1}`, PORT)).toBe(false);
    expect(isAllowedCompanionHost('localhost:80', PORT)).toBe(false);
  });

  it('rejects attacker / public hosts (DNS-rebinding vector)', () => {
    expect(isAllowedCompanionHost('evil.example', PORT)).toBe(false);
    expect(isAllowedCompanionHost(`evil.example:${PORT}`, PORT)).toBe(false);
    expect(isAllowedCompanionHost('203.0.113.7', PORT)).toBe(false);
    expect(isAllowedCompanionHost(`203.0.113.7:${PORT}`, PORT)).toBe(false);
    // A loopback substring must not sneak past the exact-match allow-list.
    expect(isAllowedCompanionHost('127.0.0.1.evil.example', PORT)).toBe(false);
    expect(isAllowedCompanionHost('notlocalhost', PORT)).toBe(false);
  });

  it('rejects a missing or empty Host header', () => {
    expect(isAllowedCompanionHost(undefined, PORT)).toBe(false);
    expect(isAllowedCompanionHost('', PORT)).toBe(false);
    expect(isAllowedCompanionHost('   ', PORT)).toBe(false);
  });

  it('rejects malformed Host headers', () => {
    expect(isAllowedCompanionHost('[::1', PORT)).toBe(false); // unterminated bracket
    expect(isAllowedCompanionHost(':8080', PORT)).toBe(false); // empty host
    expect(isAllowedCompanionHost('::1', PORT)).toBe(false); // bare (unbracketed) IPv6
  });
});
