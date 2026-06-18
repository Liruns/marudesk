// Public Suffix List validation for the omnibox's navigate-vs-search decision (DESIGN §10.4),
// backed by the vendored tldts bundle (./vendor/tldts.js) — the full PSL, not a hand-maintained
// TLD set. Synchronous (an in-memory trie), so the address bar can decide on every keystroke
// without a DNS/IPC round-trip, exactly as the §10 parsing contract requires.
import { parse } from './vendor/tldts.js';

/**
 * True when `host`'s public suffix is a real, ICANN-delegated TLD per the PSL — i.e. the dotted
 * token is a navigable domain, not a filename (`file.txt`), a decimal (`1.5`), a reserved label
 * (`.test`, `.local`), or a typo'd TLD (`foo.invalidtldxyz`).
 *
 * `isIcann` is the load-bearing field: tldts otherwise treats *any* trailing label as a "suffix"
 * (so `getDomain('file.txt')` is non-null), so a bare suffix-exists check would over-navigate.
 * Multi-level suffixes (`co.uk`, `github.io`) and IDN/punycode are handled inside tldts.
 *
 * @param {string} host  a hostname (already punycode-normalized via the URL API by callers).
 * @returns {boolean}
 */
export function isRegistrableHost(host) {
  if (!host) return false;
  return parse(host).isIcann === true;
}
