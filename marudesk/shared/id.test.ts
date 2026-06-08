import { describe, expect, it } from 'vitest';
import { randomId } from './id';

describe('randomId', () => {
  it('produces a `<prefix>-<base36>-<base36>` slug matching a prefix validator', () => {
    const id = randomId('wf');
    expect(id).toMatch(/^wf-[a-z0-9]+-[a-z0-9]+$/);
    // The body after the prefix is the [a-z0-9-]+ shape the store validators guard on.
    expect(id).toMatch(/^wf-[a-z0-9-]+$/);
  });

  it('is collision-resistant within the same millisecond', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => randomId('spec')));
    expect(ids.size).toBe(1000);
  });

  it('honours the requested prefix', () => {
    expect(randomId('spec').startsWith('spec-')).toBe(true);
    expect(randomId('wf').startsWith('wf-')).toBe(true);
  });
});
