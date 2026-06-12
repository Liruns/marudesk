import { describe, expect, it } from 'vitest';
import { closestName } from './name-suggest';

const NAMES = ['save-regression-test', 'write-plugin', 'release-notes'];

describe('closestName', () => {
  it('suggests the nearest name for a small typo', () => {
    expect(closestName('write-plugn', NAMES)).toBe('write-plugin');
    expect(closestName('relese-notes', NAMES)).toBe('release-notes');
  });

  it('matches a fragment of a longer name (containment)', () => {
    expect(closestName('regression', NAMES)).toBe('save-regression-test');
    expect(closestName('plugin', NAMES)).toBe('write-plugin');
  });

  it('is case-insensitive', () => {
    expect(closestName('Write-Plugin', NAMES)).toBe('write-plugin');
  });

  it('returns null when nothing is plausibly meant', () => {
    expect(closestName('deploy-kubernetes', NAMES)).toBeNull();
    expect(closestName('zzzz', NAMES)).toBeNull();
  });

  it('returns null for an empty query or catalog', () => {
    expect(closestName('', NAMES)).toBeNull();
    expect(closestName('   ', NAMES)).toBeNull();
    expect(closestName('write-plugin', [])).toBeNull();
  });

  it('keeps short queries from matching everything', () => {
    // 2-char query: containment is disabled, distance budget is 2.
    expect(closestName('xq', NAMES)).toBeNull();
  });
});
