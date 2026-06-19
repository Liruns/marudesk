import { describe, expect, it } from 'vitest';
import { addressNavTarget, resolveAddressBarInput } from './url';

/**
 * The omnibox parsing contract, ported from the `pane` browser
 * (reference/pane/test/url-parser.test.mjs) and adapted to marudesk's two
 * intentional divergences:
 *   1. marudesk keeps https:// for the open web (pane defaults bare hosts to
 *      http://); loopback/IP and explicit non-443 ports still use http://.
 *   2. marudesk NEVER loads file:/javascript:/data:/etc. — they route to search
 *      for safety — so Windows paths and dangerous schemes become a search
 *      rather than a file:// load.
 */

const GOOGLE = 'https://www.google.com/search?q=';
const SEARCH = (q: string) => GOOGLE + encodeURIComponent(q);

describe('resolveAddressBarInput', () => {
  const cases: [input: string, expected: string][] = [
    // trim / empty → no-op
    ['', ''],
    ['   ', ''],

    // explicit http(s) + about:blank are authoritative, never re-prefixed
    ['https://example.com', 'https://example.com'],
    ['http://example.com/path?q=1', 'http://example.com/path?q=1'],
    ['about:blank', 'about:blank'],

    // dangerous / internal / unknown schemes → search (security posture)
    ['about:config', SEARCH('about:config')],
    ['ftp://host/file', SEARCH('ftp://host/file')],
    ['javascript:alert(1)', SEARCH('javascript:alert(1)')],
    ['file:///etc/passwd', SEARCH('file:///etc/passwd')],
    ['data:text/html,<h1>x</h1>', SEARCH('data:text/html,<h1>x</h1>')],
    // Windows paths are NOT turned into file:// (unlike pane) → search
    ['C:\\dir\\file.html', SEARCH('C:\\dir\\file.html')],
    ['D:/data', SEARCH('D:/data')],

    // loopback / IP / IPv6 → http (https only for :443)
    ['localhost', 'http://localhost'],
    ['localhost:5173', 'http://localhost:5173'],
    ['app.localhost:3000', 'http://app.localhost:3000'],
    ['127.0.0.1', 'http://127.0.0.1'],
    ['127.0.0.1:8080/admin', 'http://127.0.0.1:8080/admin'],
    ['[::1]', 'http://[::1]'],
    ['[::1]:3000', 'http://[::1]:3000'],
    ['2001:db8::1', 'http://[2001:db8::1]'],

    // bare host — load only when the public suffix is a real ICANN TLD (PSL)
    ['example.com', 'https://example.com'],
    ['example.com:443', 'https://example.com:443'],
    ['example.com:8080', 'http://example.com:8080'], // dev-server port → http
    ['example.co.uk', 'https://example.co.uk'], // multi-level suffix
    ['a.github.io', 'https://a.github.io'], // ICANN .io
    ['xn--80ak6aa92e.com', 'https://xn--80ak6aa92e.com'], // punycode IDN

    // reserved / fake / file-ish dotted tokens are a search, not a host
    ['foo.local', SEARCH('foo.local')],
    ['my.test', SEARCH('my.test')],
    ['file.txt', SEARCH('file.txt')],
    ['1.5', SEARCH('1.5')],
    ['foo.invalidtldxyz', SEARCH('foo.invalidtldxyz')],

    // package denylist — a real TLD but usually a search; never auto-load
    ['socket.io', SEARCH('socket.io')],
    ['next.js', SEARCH('next.js')],

    // single-label tokens & free text → search
    ['jira', SEARCH('jira')],
    ['how to center a div', SEARCH('how to center a div')],
    ['node.js tutorial', SEARCH('node.js tutorial')],
  ];

  it.each(cases)('resolves %j', (input, expected) => {
    expect(resolveAddressBarInput(input)).toBe(expected);
  });

  it('honors the configured search engine for fallbacks', () => {
    const ddg = 'https://duckduckgo.com/?q=';
    expect(resolveAddressBarInput('how to center a div', ddg)).toBe(
      ddg + encodeURIComponent('how to center a div'),
    );
  });
});

describe('addressNavTarget', () => {
  it('returns the resolved URL for real destinations', () => {
    expect(addressNavTarget('github.com')).toBe('https://github.com');
    expect(addressNavTarget('localhost:3000')).toBe('http://localhost:3000');
    expect(addressNavTarget('https://example.com/x')).toBe('https://example.com/x');
  });

  it('offers a Go-to for a dotted real-TLD host that defaulted to search (denylist)', () => {
    // socket.io resolves to a SEARCH (denylisted), but .io is a real TLD so it's
    // still one-click navigable.
    expect(addressNavTarget('socket.io')).toBe('https://socket.io');
  });

  it('is null for prose, single labels, fake/file-ish, and non-TLD hosts', () => {
    expect(addressNavTarget('how to center a div')).toBeNull();
    expect(addressNavTarget('jira')).toBeNull();
    expect(addressNavTarget('file.txt')).toBeNull();
    expect(addressNavTarget('1.5')).toBeNull();
    expect(addressNavTarget('next.js')).toBeNull(); // .js is not an ICANN TLD
    expect(addressNavTarget('')).toBeNull();
  });
});
