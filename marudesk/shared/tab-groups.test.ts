import { describe, expect, it } from 'vitest';
import {
  addTabToGroupEntries,
  applyScopedOrder,
  assignGroup,
  dissolveGroupEntries,
  groupMemberIds,
  groupSpan,
  hiddenTabIds,
  moveTabAmongGroups,
  nearestOutsideGroup,
  nextGroupColor,
  normalizeGroupContiguity,
  removeTabFromGroupEntries,
  type GroupEntry,
} from './tab-groups';
import { TAB_GROUP_COLORS } from './browser';

const e = (id: string, groupId: string | null = null): GroupEntry => ({
  id,
  groupId,
});

const ids = (entries: readonly GroupEntry[]): string[] =>
  entries.map((x) => x.id);
const groupOf = (
  entries: readonly GroupEntry[],
  id: string,
): string | null => entries.find((x) => x.id === id)?.groupId ?? null;

describe('assignGroup (create group from a tab)', () => {
  it('makes the tab the sole member without moving it', () => {
    const next = assignGroup([e('a'), e('b'), e('c')], 'b', 'g1');
    expect(ids(next)).toEqual(['a', 'b', 'c']);
    expect(groupOf(next, 'b')).toBe('g1');
    expect(groupMemberIds(next, 'g1')).toEqual(['b']);
  });
});

describe('moveTabAmongGroups (drag reorder)', () => {
  const strip = [e('a'), e('g1a', 'g1'), e('g1b', 'g1'), e('g1c', 'g1'), e('z')];

  it('joins a group when dropped strictly inside its span', () => {
    const next = moveTabAmongGroups(strip, 'z', 'g1b');
    expect(groupOf(next, 'z')).toBe('g1');
    expect(ids(next)).toEqual(['a', 'g1a', 'z', 'g1b', 'g1c']);
    // Still contiguous.
    expect(groupSpan(next, 'g1')).toEqual({ start: 1, end: 5 });
  });

  it('leaves the group when a member is dragged out of the span', () => {
    const next = moveTabAmongGroups(strip, 'g1b', 'z');
    expect(groupOf(next, 'g1b')).toBeNull();
    expect(ids(next)).toEqual(['a', 'g1a', 'g1c', 'z', 'g1b']);
    expect(groupMemberIds(next, 'g1')).toEqual(['g1a', 'g1c']);
  });

  it('keeps membership when dragged within its own group', () => {
    const next = moveTabAmongGroups(strip, 'g1c', 'g1a');
    expect(ids(next)).toEqual(['a', 'g1c', 'g1a', 'g1b', 'z']);
    expect(groupOf(next, 'g1c')).toBe('g1');
  });

  it('does not join a foreign group when dropped at its edge', () => {
    // 'z' dropped on 'g1a' lands BEFORE the group's first member (leftward
    // drag inserts before the target): left neighbor 'a' is ungrouped, so the
    // tab stays out of the group.
    const next = moveTabAmongGroups(strip, 'z', 'g1a');
    expect(groupOf(next, 'z')).toBeNull();
    expect(ids(next)).toEqual(['a', 'z', 'g1a', 'g1b', 'g1c']);
  });

  it('re-normalizes when a non-member lands inside without joining rules met', () => {
    // Degenerate input (already split group) gets pulled back together.
    const split = [e('g1a', 'g1'), e('x'), e('g1b', 'g1')];
    const next = normalizeGroupContiguity(split);
    expect(ids(next)).toEqual(['g1a', 'g1b', 'x']);
  });

  it('is a no-op for unknown ids', () => {
    expect(ids(moveTabAmongGroups(strip, 'nope', 'g1a'))).toEqual(ids(strip));
    expect(ids(moveTabAmongGroups(strip, 'a', 'nope'))).toEqual(ids(strip));
  });
});

describe('addTabToGroupEntries / removeTabFromGroupEntries', () => {
  it('adds at the end of the group span', () => {
    const strip = [e('a'), e('g1a', 'g1'), e('g1b', 'g1'), e('z')];
    const next = addTabToGroupEntries(strip, 'z', 'g1');
    expect(ids(next)).toEqual(['a', 'g1a', 'g1b', 'z']);
    expect(groupMemberIds(next, 'g1')).toEqual(['g1a', 'g1b', 'z']);
  });

  it('moves a leftside tab into the span end when added', () => {
    const strip = [e('z'), e('g1a', 'g1'), e('g1b', 'g1'), e('c')];
    const next = addTabToGroupEntries(strip, 'z', 'g1');
    expect(ids(next)).toEqual(['g1a', 'g1b', 'z', 'c']);
  });

  it('removes a mid-group member to just after the span', () => {
    const strip = [e('g1a', 'g1'), e('g1b', 'g1'), e('g1c', 'g1'), e('z')];
    const next = removeTabFromGroupEntries(strip, 'g1b');
    expect(ids(next)).toEqual(['g1a', 'g1c', 'g1b', 'z']);
    expect(groupOf(next, 'g1b')).toBeNull();
    expect(groupMemberIds(next, 'g1')).toEqual(['g1a', 'g1c']);
  });

  it('remove is a no-op for ungrouped tabs', () => {
    const strip = [e('a'), e('b')];
    expect(removeTabFromGroupEntries(strip, 'a')).toEqual(strip);
  });
});

describe('dissolveGroupEntries (ungroup all)', () => {
  it('clears membership but keeps the order', () => {
    const strip = [e('a'), e('g1a', 'g1'), e('g1b', 'g1'), e('z', 'g2')];
    const next = dissolveGroupEntries(strip, 'g1');
    expect(ids(next)).toEqual(['a', 'g1a', 'g1b', 'z']);
    expect(groupMemberIds(next, 'g1')).toEqual([]);
    expect(groupOf(next, 'z')).toBe('g2');
  });
});

describe('hiddenTabIds (collapse)', () => {
  it('hides exactly the collapsed groups members', () => {
    const strip = [
      e('a'),
      e('g1a', 'g1'),
      e('g1b', 'g1'),
      e('g2a', 'g2'),
      e('z'),
    ];
    const hidden = hiddenTabIds(strip, (g) => g === 'g1');
    expect([...hidden].sort()).toEqual(['g1a', 'g1b']);
  });
});

describe('nearestOutsideGroup (collapse containing the active tab)', () => {
  const strip = [e('a'), e('g1a', 'g1'), e('g1b', 'g1'), e('z')];

  it('prefers the tab to the right of the span', () => {
    expect(nearestOutsideGroup(strip, 'g1', () => true)).toBe('z');
  });

  it('falls back to the left when the right side is ineligible', () => {
    expect(nearestOutsideGroup(strip, 'g1', (id) => id !== 'z')).toBe('a');
  });

  it('returns null when nothing qualifies', () => {
    expect(nearestOutsideGroup(strip, 'g1', () => false)).toBeNull();
  });
});

describe('groupMemberIds (close-group target set)', () => {
  it('returns the member ids in strip order', () => {
    const strip = [e('g1a', 'g1'), e('x'), e('g1b', 'g1')];
    expect(groupMemberIds(strip, 'g1')).toEqual(['g1a', 'g1b']);
  });
});

describe('applyScopedOrder (workspace-scoped reorder into the full order)', () => {
  it('refills the scoped slots with the new sequence', () => {
    const full = ['w1a', 'w2a', 'w1b', 'w2b', 'w1c'];
    const next = applyScopedOrder(full, ['w1c', 'w1a', 'w1b']);
    expect(next).toEqual(['w1c', 'w2a', 'w1a', 'w2b', 'w1b']);
  });

  it('ignores scoped ids missing from the full order', () => {
    const next = applyScopedOrder(['a', 'b'], ['ghost', 'b', 'a']);
    expect(next).toEqual(['b', 'a']);
  });
});

describe('nextGroupColor', () => {
  it('picks the first unused hue', () => {
    expect(nextGroupColor([])).toBe(TAB_GROUP_COLORS[0]);
    expect(nextGroupColor(['violet'])).toBe('blue');
    expect(nextGroupColor(['violet', 'teal', 'blue'])).toBe('green');
  });

  it('cycles when every hue is used', () => {
    expect(nextGroupColor([...TAB_GROUP_COLORS])).toBe(TAB_GROUP_COLORS[0]);
    expect(nextGroupColor([...TAB_GROUP_COLORS, 'violet'])).toBe(
      TAB_GROUP_COLORS[1],
    );
  });
});
