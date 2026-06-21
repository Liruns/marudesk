import { describe, expect, it } from 'vitest';
import type { WorkspaceRecord } from '../../../shared/workspace';
import { resolveWorkspaceFor } from './store';

const ws = (id: string): WorkspaceRecord => ({
  id,
  name: id.toUpperCase(),
  roots: [],
  activeRootId: null,
});

const workspaces = [ws('a'), ws('b'), ws('c')];

describe('resolveWorkspaceFor', () => {
  it('prefers an explicit workspace id over the active one', () => {
    // An instrument bound to "b" must show "b" even though "a" is globally active.
    expect(resolveWorkspaceFor(workspaces, 'b', 'a')?.id).toBe('b');
  });

  it('falls back to the active workspace when no preferred id is given', () => {
    expect(resolveWorkspaceFor(workspaces, undefined, 'a')?.id).toBe('a');
  });

  it('falls back to the active workspace when the preferred id is unknown', () => {
    // A stale binding degrades to the active workspace rather than null.
    expect(resolveWorkspaceFor(workspaces, 'gone', 'c')?.id).toBe('c');
  });

  it('returns null when neither the preferred nor the active id resolves', () => {
    expect(resolveWorkspaceFor(workspaces, undefined, null)).toBeNull();
    expect(resolveWorkspaceFor(workspaces, 'gone', 'also-gone')).toBeNull();
  });

  it('returns null for an empty workspace list', () => {
    expect(resolveWorkspaceFor([], 'a', 'a')).toBeNull();
  });
});
