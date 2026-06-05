import type { WorkspaceRecord, WorkspaceRootSummary } from '../shared/workspace';

/**
 * Pure lookups over the registry's workspace records, shared by the workspace
 * registry and the agent's context sources so the "which root is active"
 * resolution can't drift between them.
 */

/** Find a workspace by id, or null. */
export function workspaceById(
  workspaces: readonly WorkspaceRecord[],
  workspaceId: string,
): WorkspaceRecord | null {
  return workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
}

/** A workspace's active root: the explicitly-selected one if present, else the first. */
export function activeRoot(record: WorkspaceRecord): WorkspaceRootSummary | null {
  const preferred = record.activeRootId
    ? record.roots.find((root) => root.id === record.activeRootId)
    : undefined;
  return preferred ?? record.roots[0] ?? null;
}

/** Find a root within a workspace by id, or null. */
export function rootById(record: WorkspaceRecord, rootId: string): WorkspaceRootSummary | null {
  return record.roots.find((root) => root.id === rootId) ?? null;
}
