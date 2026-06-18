import { describe, expect, it } from 'vitest';
import {
  INTERNAL_NEWTAB_URL,
  buildInternalErrorUrl,
  displayUrl,
  isInternalUrl,
  parseInternalErrorUrl,
} from './internal-pages';

describe('internal-pages contract', () => {
  it('round-trips an error URL', () => {
    const info = {
      failedUrl: 'https://example.com/a?b=1',
      code: -105,
      description: 'ERR_NAME_NOT_RESOLVED',
    };
    const url = buildInternalErrorUrl(info);
    expect(url.startsWith('maru://error?')).toBe(true);
    expect(parseInternalErrorUrl(url)).toEqual(info);
  });

  it('parseInternalErrorUrl returns null for non-error URLs', () => {
    expect(parseInternalErrorUrl(INTERNAL_NEWTAB_URL)).toBeNull();
    expect(parseInternalErrorUrl('https://example.com')).toBeNull();
  });

  it('isInternalUrl recognizes the maru:// scheme only', () => {
    expect(isInternalUrl(INTERNAL_NEWTAB_URL)).toBe(true);
    expect(isInternalUrl('maru://error?url=x')).toBe(true);
    expect(isInternalUrl('https://maru.example')).toBe(false);
    expect(isInternalUrl('about:blank')).toBe(false);
  });

  describe('displayUrl', () => {
    it('blanks new-tab and about:blank', () => {
      expect(displayUrl(INTERNAL_NEWTAB_URL)).toBe('');
      expect(displayUrl('about:blank')).toBe('');
      expect(displayUrl('')).toBe('');
    });

    it('maps an error page back to the failed URL', () => {
      const url = buildInternalErrorUrl({
        failedUrl: 'https://down.example/path',
        code: -7,
        description: 'ERR_TIMED_OUT',
      });
      expect(displayUrl(url)).toBe('https://down.example/path');
    });

    it('passes real URLs through unchanged', () => {
      expect(displayUrl('https://example.com')).toBe('https://example.com');
    });
  });
});
