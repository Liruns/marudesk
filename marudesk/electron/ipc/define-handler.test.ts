import { describe, expect, it } from 'vitest';
import { isAuthorizedSender, isTrustedSenderFrame } from './define-handler';

describe('isTrustedSenderFrame', () => {
  const entry = 'file:///C:/app/dist/index.html';

  it('trusts the exact entry URL (host top frame)', () => {
    expect(isTrustedSenderFrame(entry, entry)).toBe(true);
  });

  it('trusts the entry document with a differing hash (client-side route)', () => {
    expect(isTrustedSenderFrame(`${entry}#/settings`, entry)).toBe(true);
  });

  it('trusts the pop-out DevTools route (same path, devtools hash)', () => {
    // electron/browser/devtools-window.ts loads `base + '#/devtools/<tabId>'`,
    // where `base` is the host URL with the hash stripped — same origin+pathname.
    expect(isTrustedSenderFrame(`${entry}#/devtools/tab-7`, entry)).toBe(true);
  });

  it('trusts the entry document with a differing query', () => {
    expect(isTrustedSenderFrame(`${entry}?task=42`, entry)).toBe(true);
  });

  it('trusts the entry document with both query and hash', () => {
    expect(isTrustedSenderFrame(`${entry}?task=42#/log`, entry)).toBe(true);
  });

  it('rejects an embedded browser tab on a remote origin', () => {
    expect(isTrustedSenderFrame('https://attacker.test/index.html', entry)).toBe(false);
  });

  it('rejects an embedded tab on http', () => {
    expect(isTrustedSenderFrame('http://example.com/', entry)).toBe(false);
  });

  it('rejects a different local file path', () => {
    expect(isTrustedSenderFrame('file:///C:/Users/victim/evil.html', entry)).toBe(false);
  });

  it('rejects a sibling file in the same directory', () => {
    expect(isTrustedSenderFrame('file:///C:/app/dist/other.html', entry)).toBe(false);
  });

  it('rejects the maru:// internal new-tab/error pages', () => {
    expect(isTrustedSenderFrame('maru://newtab/', entry)).toBe(false);
  });

  it('rejects an unparseable sender url', () => {
    expect(isTrustedSenderFrame('not a url', entry)).toBe(false);
  });

  it('rejects when the entry itself is unparseable', () => {
    expect(isTrustedSenderFrame(entry, 'not a url')).toBe(false);
  });

  it('works for a dev-server (http) entry: trusts same path, rejects other origins', () => {
    const devEntry = 'http://localhost:5173/';
    expect(isTrustedSenderFrame('http://localhost:5173/#/devtools/x', devEntry)).toBe(true);
    expect(isTrustedSenderFrame('http://localhost:5173/embedded.html', devEntry)).toBe(false);
    expect(isTrustedSenderFrame('http://evil.localhost:5173/', devEntry)).toBe(false);
  });
});

describe('isAuthorizedSender', () => {
  const entry = 'file:///C:/app/dist/index.html';

  it('accepts the trusted host frame once the entry is wired', () => {
    expect(isAuthorizedSender(entry, entry)).toBe(true);
    expect(isAuthorizedSender(`${entry}#/devtools/tab-7`, entry)).toBe(true);
  });

  it('rejects a foreign frame once the entry is wired', () => {
    expect(isAuthorizedSender('https://attacker.test/index.html', entry)).toBe(false);
  });

  it('rejects an empty sender url once the entry is wired (fail closed)', () => {
    expect(isAuthorizedSender('', entry)).toBe(false);
  });

  it('rejects an absent sender url once the entry is wired (fail closed)', () => {
    expect(isAuthorizedSender(undefined, entry)).toBe(false);
  });

  it('accepts an empty sender url before the entry is wired (pre-wire fail open)', () => {
    expect(isAuthorizedSender('', null)).toBe(true);
  });

  it('accepts an absent sender url before the entry is wired (pre-wire fail open)', () => {
    expect(isAuthorizedSender(undefined, null)).toBe(true);
  });

  it('accepts any sender before the entry is wired (pre-wire fail open)', () => {
    expect(isAuthorizedSender('https://attacker.test/', null)).toBe(true);
  });
});
