import { describe, expect, it } from 'vitest';
import {
  sanitizePersistedRegistry,
  toPersisted,
} from './workspace-persistence';
import type { WorkspaceRecord } from '../shared/workspace';

const record: WorkspaceRecord = {
  id: 'ws1',
  name: 'Project',
  activeRootId: 'r1',
  roots: [
    {
      id: 'r1',
      name: 'app',
      root: '/home/u/app',
      files: [{ path: 'a.ts', size: 10 }],
      source: 'git',
      truncated: false,
    },
    {
      id: 'r2',
      name: 'remote',
      root: 'ssh://conn/srv',
      files: [],
      source: 'walk',
      truncated: false,
      connection: { kind: 'ssh', connectionId: 'conn', host: 'h', username: 'u', remotePath: '/srv' },
    },
  ],
};

describe('toPersisted', () => {
  it('drops file indexes but keeps identity + connection', () => {
    const out = toPersisted([record], 'ws1');
    expect(out.activeWorkspaceId).toBe('ws1');
    expect(out.workspaces).toHaveLength(1);
    const w = out.workspaces[0];
    expect(w).toMatchObject({ id: 'ws1', name: 'Project', activeRootId: 'r1' });
    expect(w.roots[0]).toEqual({ id: 'r1', name: 'app', root: '/home/u/app' });
    expect(w.roots[1].connection).toEqual({
      kind: 'ssh',
      connectionId: 'conn',
      host: 'h',
      username: 'u',
      remotePath: '/srv',
    });
    // No file arrays persisted.
    expect('files' in w.roots[0]).toBe(false);
  });
});

describe('sanitizePersistedRegistry', () => {
  it('round-trips a valid persisted registry', () => {
    const persisted = toPersisted([record], 'ws1');
    expect(sanitizePersistedRegistry(JSON.parse(JSON.stringify(persisted)))).toEqual(persisted);
  });

  it('returns empty for junk', () => {
    expect(sanitizePersistedRegistry(null)).toEqual({ activeWorkspaceId: null, workspaces: [] });
    expect(sanitizePersistedRegistry({ workspaces: 'x' })).toEqual({ activeWorkspaceId: null, workspaces: [] });
  });

  it('drops workspaces with no valid roots and resets a dangling active id', () => {
    const out = sanitizePersistedRegistry({
      activeWorkspaceId: 'gone',
      workspaces: [
        { id: 'a', name: 'A', roots: [] },
        { id: 'b', name: 'B', roots: [{ id: 'rb', name: 'rb', root: '/b' }] },
      ],
    });
    expect(out.workspaces.map((w) => w.id)).toEqual(['b']);
    expect(out.activeWorkspaceId).toBe('b');
  });

  it('falls back activeRootId to the first root when invalid', () => {
    const out = sanitizePersistedRegistry({
      workspaces: [{ id: 'a', name: 'A', activeRootId: 'nope', roots: [{ id: 'r1', name: 'r', root: '/a' }] }],
    });
    expect(out.workspaces[0].activeRootId).toBe('r1');
  });
});
