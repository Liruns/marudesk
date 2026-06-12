import { describe, expect, it } from 'vitest';
import {
  groupScriptsByOrigin,
  isInternalScriptUrl,
  scriptLabel,
  scriptOrigin,
} from './sources-utils';
import type { ScriptInfo } from './types';

describe('isInternalScriptUrl', () => {
  it('drops extension/devtools/electron internals', () => {
    expect(isInternalScriptUrl('chrome-extension://abc/bg.js')).toBe(true);
    expect(isInternalScriptUrl('extensions::event_bindings')).toBe(true);
    expect(isInternalScriptUrl('devtools://devtools/bundled/root.js')).toBe(true);
    expect(isInternalScriptUrl('node:internal/process')).toBe(true);
  });

  it('keeps regular page scripts', () => {
    expect(isInternalScriptUrl('https://example.com/app.js')).toBe(false);
    expect(isInternalScriptUrl('http://localhost:5173/src/main.tsx')).toBe(false);
  });
});

describe('scriptLabel', () => {
  it('returns the file name, keeping the query string', () => {
    expect(scriptLabel('https://example.com/js/app.min.js')).toBe('app.min.js');
    expect(scriptLabel('http://localhost:5173/src/main.tsx?t=123')).toBe('main.tsx?t=123');
  });

  it('falls back to the host for an origin-root url', () => {
    expect(scriptLabel('https://example.com/')).toBe('example.com');
  });

  it('handles non-URL strings', () => {
    expect(scriptLabel('webpack://app/./src/index.js')).toBe('index.js');
  });
});

describe('scriptOrigin', () => {
  it('extracts the origin', () => {
    expect(scriptOrigin('https://example.com:8443/a/b.js')).toBe('https://example.com:8443');
  });

  it('buckets unparseable urls', () => {
    expect(scriptOrigin('not a url')).toBe('(no origin)');
  });
});

describe('groupScriptsByOrigin', () => {
  const scripts: ScriptInfo[] = [
    { scriptId: '1', url: 'https://b.com/z.js' },
    { scriptId: '2', url: 'https://a.com/y.js' },
    { scriptId: '3', url: 'https://a.com/x.js' },
  ];

  it('groups by origin, sorted, with sorted scripts inside', () => {
    const groups = groupScriptsByOrigin(scripts, '');
    expect(groups.map((g) => g.origin)).toEqual(['https://a.com', 'https://b.com']);
    expect(groups[0].scripts.map((s) => s.url)).toEqual([
      'https://a.com/x.js',
      'https://a.com/y.js',
    ]);
  });

  it('filters by case-insensitive substring on the url', () => {
    const groups = groupScriptsByOrigin(scripts, 'X.JS');
    expect(groups).toHaveLength(1);
    expect(groups[0].scripts).toHaveLength(1);
    expect(groups[0].scripts[0].scriptId).toBe('3');
  });
});
