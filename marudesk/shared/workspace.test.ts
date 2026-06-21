import { describe, expect, it } from 'vitest';
import { resolveActiveRootId } from './workspace';
import type { WorkspaceRecord } from './workspace';

const ws = (
  activeRootId: WorkspaceRecord['activeRootId'],
  rootIds: string[],
): WorkspaceRecord => ({
  id: 'w',
  name: 'W',
  activeRootId,
  roots: rootIds.map((id) => ({
    id,
    name: id,
    root: `/${id}`,
    files: [],
    source: 'walk',
    truncated: false,
  })),
});

describe('resolveActiveRootId', () => {
  it('prefers an explicit activeRootId', () => {
    expect(resolveActiveRootId(ws('r2', ['r1', 'r2']))).toBe('r2');
  });

  it('falls back to the first root when activeRootId is null', () => {
    expect(resolveActiveRootId(ws(null, ['r1', 'r2']))).toBe('r1');
  });

  it('returns null when there are no roots', () => {
    expect(resolveActiveRootId(ws(null, []))).toBeNull();
  });

  it('returns null for a null/undefined workspace', () => {
    expect(resolveActiveRootId(null)).toBeNull();
    expect(resolveActiveRootId(undefined)).toBeNull();
  });
});
