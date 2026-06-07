import { describe, expect, it } from 'vitest';
import { DEFAULT_PROFILE_ID, sanitizeProfiles } from '../shared/profiles';

describe('sanitizeProfiles', () => {
  it('returns a default profile for junk', () => {
    const s = sanitizeProfiles(null);
    expect(s.activeProfileId).toBe(DEFAULT_PROFILE_ID);
    expect(s.profiles).toEqual([{ id: DEFAULT_PROFILE_ID, name: 'Default' }]);
  });

  it('always guarantees a default profile', () => {
    const s = sanitizeProfiles({ activeProfileId: 'x', profiles: [{ id: 'x', name: 'Work' }] });
    expect(s.profiles.some((p) => p.id === DEFAULT_PROFILE_ID)).toBe(true);
    expect(s.activeProfileId).toBe('x');
  });

  it('dedupes ids and drops malformed entries', () => {
    const s = sanitizeProfiles({
      activeProfileId: 'a',
      profiles: [
        { id: 'a', name: 'A' },
        { id: 'a', name: 'dup' },
        { id: 'b' },
        'nope',
      ],
    });
    expect(s.profiles.filter((p) => p.id === 'a')).toHaveLength(1);
    expect(s.profiles.some((p) => p.id === 'b')).toBe(false);
  });

  it('resets a dangling active id to default', () => {
    const s = sanitizeProfiles({ activeProfileId: 'gone', profiles: [{ id: 'a', name: 'A' }] });
    expect(s.activeProfileId).toBe(DEFAULT_PROFILE_ID);
  });
});
