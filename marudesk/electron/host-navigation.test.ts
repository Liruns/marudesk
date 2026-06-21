import { describe, expect, it } from 'vitest';
import { isAllowedHostNavigation } from './host-navigation';

describe('isAllowedHostNavigation', () => {
  const entry = 'file:///C:/app/dist/index.html';

  it('allows the exact entry URL', () => {
    expect(isAllowedHostNavigation(entry, entry)).toBe(true);
  });

  it('allows the entry document with a differing hash', () => {
    expect(isAllowedHostNavigation(`${entry}#/settings`, entry)).toBe(true);
  });

  it('allows the entry document with a differing query', () => {
    expect(isAllowedHostNavigation(`${entry}?task=42`, entry)).toBe(true);
  });

  it('allows the entry document with both query and hash', () => {
    expect(isAllowedHostNavigation(`${entry}?task=42#/log`, entry)).toBe(true);
  });

  it('rejects a different local file path', () => {
    expect(isAllowedHostNavigation('file:///C:/Users/victim/evil.html', entry)).toBe(false);
  });

  it('rejects a sibling file in the same directory', () => {
    expect(isAllowedHostNavigation('file:///C:/app/dist/other.html', entry)).toBe(false);
  });

  it('rejects an http URL', () => {
    expect(isAllowedHostNavigation('http://example.com/', entry)).toBe(false);
  });

  it('rejects an https URL', () => {
    expect(isAllowedHostNavigation('https://attacker.test/index.html', entry)).toBe(false);
  });

  it('rejects an unparseable target', () => {
    expect(isAllowedHostNavigation('not a url', entry)).toBe(false);
  });

  it('rejects when the entry itself is unparseable', () => {
    expect(isAllowedHostNavigation(entry, 'not a url')).toBe(false);
  });

  it('works for a dev-server (http) entry: allows same path, rejects other origins', () => {
    const devEntry = 'http://localhost:5173/';
    expect(isAllowedHostNavigation('http://localhost:5173/#/x', devEntry)).toBe(true);
    expect(isAllowedHostNavigation('http://localhost:5173/other', devEntry)).toBe(false);
    expect(isAllowedHostNavigation('http://evil.localhost:5173/', devEntry)).toBe(false);
  });
});
