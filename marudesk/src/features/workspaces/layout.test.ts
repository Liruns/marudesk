import { describe, expect, it } from 'vitest';
import { sanitizeWorkspaceLayout, workspaceLeaves } from './layout';

const valid = (ids: string[]) => (id: string) => ids.includes(id);

describe('sanitizeWorkspaceLayout', () => {
  it('returns null for non-objects', () => {
    expect(sanitizeWorkspaceLayout(null, valid(['a']))).toBeNull();
    expect(sanitizeWorkspaceLayout('x', valid(['a']))).toBeNull();
  });

  it('keeps a leaf whose workspace exists', () => {
    const out = sanitizeWorkspaceLayout({ type: 'leaf', id: 'p1', workspaceId: 'a' }, valid(['a']));
    expect(out).toEqual({ type: 'leaf', id: 'p1', workspaceId: 'a' });
  });

  it('drops a leaf whose workspace is gone', () => {
    expect(sanitizeWorkspaceLayout({ type: 'leaf', id: 'p1', workspaceId: 'gone' }, valid(['a']))).toBeNull();
  });

  it('collapses a split to its surviving child', () => {
    const tree = {
      type: 'split',
      id: 's1',
      dir: 'row',
      ratio: 0.4,
      a: { type: 'leaf', id: 'p1', workspaceId: 'gone' },
      b: { type: 'leaf', id: 'p2', workspaceId: 'b' },
    };
    const out = sanitizeWorkspaceLayout(tree, valid(['b']));
    expect(out).toEqual({ type: 'leaf', id: 'p2', workspaceId: 'b' });
  });

  it('keeps a valid split and clamps the ratio', () => {
    const tree = {
      type: 'split',
      id: 's1',
      dir: 'col',
      ratio: 5, // out of range → clamped
      a: { type: 'leaf', id: 'p1', workspaceId: 'a' },
      b: { type: 'leaf', id: 'p2', workspaceId: 'b' },
    };
    const out = sanitizeWorkspaceLayout(tree, valid(['a', 'b']));
    expect(out?.type).toBe('split');
    expect(workspaceLeaves(out!).map((l) => l.workspaceId)).toEqual(['a', 'b']);
    if (out?.type === 'split') expect(out.ratio).toBeLessThanOrEqual(0.88);
  });
});
