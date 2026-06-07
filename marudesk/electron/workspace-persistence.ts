import { app } from 'electron';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { atomicWriteFile } from './fs-safe';
import type {
  WorkspaceConnection,
  WorkspaceId,
  WorkspaceRecord,
} from '../shared/workspace';

/**
 * Workspace-registry persistence. The live registry (workspace-registry.ts) is
 * in-memory only, so every workspace vanished on restart. We persist a LIGHT
 * snapshot — workspace + root identity (ids, names, root paths/keys, ssh
 * connection metadata) but NOT the (re-derivable, potentially large) file
 * indexes — to userData/workspaces.json. On launch the registry rebuilds the
 * records and re-indexes local roots; ssh roots restore without a live
 * connection and fill in when reconnected/reindexed.
 *
 * The pure transform/sanitize helpers are unit-tested; the file I/O is a thin
 * wrapper around them.
 */

export type PersistedRoot = {
  id: string;
  name: string;
  root: string;
  connection?: WorkspaceConnection;
};

export type PersistedWorkspace = {
  id: string;
  name: string;
  activeRootId: string | null;
  roots: PersistedRoot[];
};

export type PersistedRegistry = {
  activeWorkspaceId: WorkspaceId | null;
  workspaces: PersistedWorkspace[];
};

const EMPTY: PersistedRegistry = { activeWorkspaceId: null, workspaces: [] };

function registryFile(): string {
  return path.join(app.getPath('userData'), 'workspaces.json');
}

/** Light, persistable view of the live registry (no file indexes). */
export function toPersisted(
  records: readonly WorkspaceRecord[],
  activeWorkspaceId: WorkspaceId | null,
): PersistedRegistry {
  return {
    activeWorkspaceId,
    workspaces: records.map((r) => ({
      id: r.id,
      name: r.name,
      activeRootId: r.activeRootId,
      roots: r.roots.map((root) => ({
        id: root.id,
        name: root.name,
        root: root.root,
        ...(root.connection ? { connection: root.connection } : {}),
      })),
    })),
  };
}

function sanitizeConnection(value: unknown): WorkspaceConnection | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const o = value as Record<string, unknown>;
  if (o.kind === 'local') return { kind: 'local' };
  if (
    o.kind === 'ssh' &&
    typeof o.connectionId === 'string' &&
    typeof o.host === 'string' &&
    typeof o.username === 'string' &&
    typeof o.remotePath === 'string'
  ) {
    return {
      kind: 'ssh',
      connectionId: o.connectionId,
      host: o.host,
      username: o.username,
      remotePath: o.remotePath,
    };
  }
  return undefined;
}

function sanitizeRoot(value: unknown): PersistedRoot | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.name !== 'string' || typeof o.root !== 'string') {
    return null;
  }
  const connection = sanitizeConnection(o.connection);
  return { id: o.id, name: o.name, root: o.root, ...(connection ? { connection } : {}) };
}

function sanitizeWorkspace(value: unknown): PersistedWorkspace | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.name !== 'string') return null;
  const roots = Array.isArray(o.roots)
    ? o.roots.map(sanitizeRoot).filter((r): r is PersistedRoot => r !== null)
    : [];
  if (roots.length === 0) return null;
  const activeRootId =
    typeof o.activeRootId === 'string' && roots.some((r) => r.id === o.activeRootId)
      ? o.activeRootId
      : (roots[0]?.id ?? null);
  return { id: o.id, name: o.name, activeRootId, roots };
}

/** Coerce arbitrary JSON into a valid PersistedRegistry; drops malformed parts. */
export function sanitizePersistedRegistry(parsed: unknown): PersistedRegistry {
  if (!parsed || typeof parsed !== 'object') return { ...EMPTY };
  const o = parsed as Record<string, unknown>;
  const workspaces = Array.isArray(o.workspaces)
    ? o.workspaces.map(sanitizeWorkspace).filter((w): w is PersistedWorkspace => w !== null)
    : [];
  const activeWorkspaceId =
    typeof o.activeWorkspaceId === 'string' && workspaces.some((w) => w.id === o.activeWorkspaceId)
      ? o.activeWorkspaceId
      : (workspaces[0]?.id ?? null);
  return { activeWorkspaceId, workspaces };
}

/** Persist the registry (fire-and-forget; never throws to the caller). */
export function saveWorkspaceRegistry(
  records: readonly WorkspaceRecord[],
  activeWorkspaceId: WorkspaceId | null,
): void {
  try {
    void atomicWriteFile(registryFile(), JSON.stringify(toPersisted(records, activeWorkspaceId)));
  } catch {
    // Best-effort — a failed write must never break workspace operations.
  }
}

/** Read the persisted registry synchronously (startup). Empty on any error. */
export function loadPersistedRegistry(): PersistedRegistry {
  try {
    return sanitizePersistedRegistry(JSON.parse(readFileSync(registryFile(), 'utf8')));
  } catch {
    return { ...EMPTY };
  }
}
