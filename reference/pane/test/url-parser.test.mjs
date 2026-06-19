// The omnibox parsing contract (DESIGN §10). Pure-function tests over toNavURL — the one piece
// of real logic in v0's chrome. ESM (.mjs) because the renderer module is ESM; it pulls in the
// vendored tldts bundle (the Public Suffix List) for the real-host decision, all runnable in Node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toNavURL, search } from '../src/renderer/features/url-parser.js';

const SEARCH = (q) => search(q);

// [input, expected]. expected === null means no-op; a search() result means "search, don't load".
const cases = [
  // 1. trim / empty
  ['', null],
  ['   ', null],

  // 2. explicit scheme is authoritative — never re-prefixed
  ['https://example.com', 'https://example.com'],
  ['http://example.com/path?q=1', 'http://example.com/path?q=1'],
  ['about:blank', 'about:blank'],
  ['about:config', SEARCH('about:config')],          // non-blank about: → search, not loadURL
  ['ftp://host/file', SEARCH('ftp://host/file')],     // unknown scheme typed as text → search

  // Windows path → file URL (normalize backslashes)
  ['C:\\dir\\file.html', 'file:///C:/dir/file.html'],
  ['D:/data', 'file:///D:/data'],

  // 3. loopback / IP / bracketed IPv6 — load (http assumed; https only for :443)
  ['localhost', 'http://localhost'],
  ['localhost:5173', 'http://localhost:5173'],
  ['127.0.0.1', 'http://127.0.0.1'],
  ['127.0.0.1:8080/admin', 'http://127.0.0.1:8080/admin'],
  ['[::1]', 'http://[::1]'],
  ['[::1]:3000', 'http://[::1]:3000'],
  ['2001:db8::1', 'http://[2001:db8::1]'],            // bare (unbracketed) IPv6 → wrap

  // 4. bare host — load only when the public suffix is a real ICANN TLD (PSL via tldts)
  ['example.com', 'http://example.com'],              // http by default (dev-server friendly, §10.3)
  ['example.com:443', 'https://example.com:443'],     // :443 ⇒ https (port kept)
  ['example.co.uk', 'http://example.co.uk'],          // multi-level suffix
  ['a.github.io', 'http://a.github.io'],              // private-section host, ICANN .io
  ['xn--80ak6aa92e.com', 'http://xn--80ak6aa92e.com'],// punycode IDN

  // ...but reserved / fake / file-ish dotted tokens are a search, not a host
  ['foo.local', SEARCH('foo.local')],
  ['my.test', SEARCH('my.test')],
  ['file.txt', SEARCH('file.txt')],
  ['1.5', SEARCH('1.5')],
  ['foo.invalidtldxyz', SEARCH('foo.invalidtldxyz')],

  // package denylist — a real TLD (.io/.js) but usually a search; never auto-load (§10.4)
  ['socket.io', SEARCH('socket.io')],
  ['next.js', SEARCH('next.js')],

  // 5/6. single-label tokens & free text → search
  ['jira', SEARCH('jira')],
  ['how to center a div', SEARCH('how to center a div')],
  ['node.js tutorial', SEARCH('node.js tutorial')],   // dotted but has whitespace → search
];

for (const [input, expected] of cases) {
  test(`toNavURL(${JSON.stringify(input)})`, () => {
    assert.equal(toNavURL(input), expected);
  });
}
