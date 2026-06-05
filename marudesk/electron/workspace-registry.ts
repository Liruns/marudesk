import { dialog, type BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  SYSTEM_WORKSPACE_ID,
  type WorkspaceFileRef,
  type WorkspaceId,
  type WorkspacePaneId,
  type WorkspaceRecord,
  type WorkspaceRootId,
  type WorkspaceRootInput,
  type WorkspaceRootSummary,
  type WorkspaceSummary,
  type WorkspaceSnapshot,
  type WorkspaceSaveAsResult,
} from '../shared/workspace';
import { isSshRootKey, sshRootKey } from '../shared/ssh';
import { activeRoot } from './workspace-helpers';
import { defineHandler, requireWorkspace } from './ipc/define-handler';
import { arrayOf, obj, str } from './ipc/validate';
import { getConnectionInfo } from './ssh/connection-manager';
import {
  readFileForEditor,
  readMediaForPreview,
  saveAsForEditor,
  writeFileForEditor,
} from './workspace-files';
import { summarizeWorkspace } from './workspace-index';
import { isCaptureInput, rankFiles } from './workspace-rank';

let currentWorkspace: WorkspaceSummary | null = null;
const workspaceRecords = new Map<WorkspaceId, WorkspaceRecord>();
let activeWorkspaceId: WorkspaceId | null = null;
let focusedPaneId: WorkspacePaneId | null = null;
let workspaceRevision = 0;

export function getCurrentWorkspace(): WorkspaceSummary | null {
  return summaryForActiveRoot() ?? currentWorkspace;
}

export function getActiveWorkspaceId(): WorkspaceId {
  return activeWorkspaceId ?? SYSTEM_WORKSPACE_ID;
}

export function getWorkspaceSnapshot(): WorkspaceSnapshot {
  return snapshot();
}

function createId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function activeRecord(): WorkspaceRecord | null {
  return activeWorkspaceId ? (workspaceRecords.get(activeWorkspaceId) ?? null) : null;
}


function rootToLegacySummary(
  record: WorkspaceRecord,
  root: WorkspaceRootSummary,
): WorkspaceSummary {
  return {
    root: root.root,
    name: record.roots.length > 1 ? `${record.name} / ${root.name}` : record.name,
    files: root.files,
    source: root.source,
    truncated: root.truncated,
  };
}

function summaryForActiveRoot(): WorkspaceSummary | null {
  const record = activeRecord();
  if (!record) return null;
  const root = activeRoot(record);
  return root ? rootToLegacySummary(record, root) : null;
}

function refreshCurrentWorkspace(): void {
  currentWorkspace = summaryForActiveRoot();
}

function snapshot(): WorkspaceSnapshot {
  return {
    revision: workspaceRevision,
    workspaces: [...workspaceRecords.values()],
    activeWorkspaceId,
    focusedWorkspaceId: activeWorkspaceId,
    focusedPaneId,
  };
}

function requireRecord(workspaceId: WorkspaceId): WorkspaceRecord {
  const record = workspaceRecords.get(workspaceId);
  if (!record) throw new Error(`workspace not found: ${workspaceId}`);
  return record;
}

function requireRoot(
  record: WorkspaceRecord,
  rootId: WorkspaceRootId,
): WorkspaceRootSummary {
  const root = record.roots.find((entry) => entry.id === rootId);
  if (!root) throw new Error(`workspace root not found: ${rootId}`);
  return root;
}

function requireFileRef(value: unknown): {
  file: WorkspaceFileRef;
  record: WorkspaceRecord;
  root: WorkspaceRootSummary;
} {
  const p = obj(value);
  const file: WorkspaceFileRef = {
    workspaceId: str(p.workspaceId, 'workspaceId'),
    rootId: str(p.rootId, 'rootId'),
    path: str(p.path, 'path'),
  };
  const record = requireRecord(file.workspaceId);
  const root = requireRoot(record, file.rootId);
  return { file, record, root };
}

function toRootInput(value: unknown, index: number): WorkspaceRootInput {
  const p = obj(value, `roots[${index}]`);
  return {
    name: str(p.name, `roots[${index}].name`).trim(),
    path: str(p.path, `roots[${index}].path`),
  };
}

async function summarizeRoot(input: WorkspaceRootInput): Promise<WorkspaceRootSummary> {
  const name = input.name.trim();
  if (!name) throw new Error('root name must not be empty');
  const summary = await summarizeWorkspace(input.path);
  return {
    id: createId('root'),
    name,
    root: summary.root,
    files: summary.files,
    source: summary.source,
    truncated: summary.truncated,
  };
}

async function createWorkspaceRecord(
  name: string,
  roots: readonly WorkspaceRootInput[],
): Promise<WorkspaceRecord> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('workspace name must not be empty');
  if (roots.length === 0) throw new Error('workspace roots must not be empty');
  const summaries: WorkspaceRootSummary[] = [];
  for (const input of roots) {
    summaries.push(await summarizeRoot(input));
  }
  const record: WorkspaceRecord = {
    id: createId('workspace'),
    name: trimmed,
    roots: summaries,
    activeRootId: summaries[0]?.id ?? null,
  };
  workspaceRecords.set(record.id, record);
  activeWorkspaceId = record.id;
  refreshCurrentWorkspace();
  return record;
}

function recordFromLegacySummary(summary: WorkspaceSummary): WorkspaceRecord {
  const root: WorkspaceRootSummary = {
    id: createId('root'),
    name: summary.name,
    root: summary.root,
    files: summary.files,
    source: summary.source,
    truncated: summary.truncated,
  };
  const record: WorkspaceRecord = {
    id: createId('workspace'),
    name: summary.name,
    roots: [root],
    activeRootId: root.id,
  };
  workspaceRecords.set(record.id, record);
  activeWorkspaceId = record.id;
  refreshCurrentWorkspace();
  return record;
}

/**
 * Bridge a legacy single-root open/list onto the deck. Idempotent by root path:
 * if a workspace already holds that folder, refresh that root in place and make
 * it active instead of spawning a duplicate. Without this, every legacy
 * `workspace:list(root)` (e.g. the Explorer's Refresh button or re-opening a
 * recent) would pile a fresh workspace onto the rail.
 */
function upsertLegacyWorkspace(summary: WorkspaceSummary): WorkspaceRecord {
  for (const record of workspaceRecords.values()) {
    const index = record.roots.findIndex((root) => root.root === summary.root);
    if (index === -1) continue;
    const roots = [...record.roots];
    roots[index] = {
      ...roots[index],
      files: summary.files,
      source: summary.source,
      truncated: summary.truncated,
    };
    const next: WorkspaceRecord = { ...record, roots, activeRootId: roots[index].id };
    workspaceRecords.set(next.id, next);
    activeWorkspaceId = next.id;
    refreshCurrentWorkspace();
    return next;
  }
  return recordFromLegacySummary(summary);
}

async function reindexRoot(root: WorkspaceRootSummary): Promise<WorkspaceRootSummary> {
  const next = await summarizeWorkspace(root.root);
  return {
    ...root,
    files: next.files,
    source: next.source,
    truncated: next.truncated,
  };
}

async function reindexRecord(
  workspaceId: WorkspaceId,
  rootId?: WorkspaceRootId,
): Promise<WorkspaceRecord> {
  const record = requireRecord(workspaceId);
  const roots: WorkspaceRootSummary[] = [];
  for (const root of record.roots) {
    roots.push(!rootId || root.id === rootId ? await reindexRoot(root) : root);
  }
  if (rootId && roots.every((root) => root.id !== rootId)) {
    throw new Error(`workspace root not found: ${rootId}`);
  }
  const next = { ...record, roots };
  workspaceRecords.set(next.id, next);
  if (activeWorkspaceId === next.id) refreshCurrentWorkspace();
  return next;
}

async function openWorkspace(
  parentWindow: BrowserWindow,
): Promise<WorkspaceSummary | null> {
  const result = await dialog.showOpenDialog(parentWindow, {
    properties: ['openDirectory'],
    title: 'Open workspace',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return summarizeWorkspace(result.filePaths[0]);
}

async function pickWorkspaceRoot(
  parentWindow: BrowserWindow,
): Promise<WorkspaceRootInput | null> {
  const result = await dialog.showOpenDialog(parentWindow, {
    properties: ['openDirectory'],
    title: 'Add folder to workspace',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const rootPath = result.filePaths[0];
  return {
    name: path.basename(rootPath),
    path: rootPath,
  };
}

export function registerWorkspaceHandlers(deps: {
  getMainWindow: () => BrowserWindow | null;
}): void {
  const pushWorkspaceState = (): void => {
    workspaceRevision += 1;
    const next = snapshot();
    const win = deps.getMainWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send('workspaces:state', next);
  };

  defineHandler('workspace:open', async () => {
    const win = deps.getMainWindow();
    if (!win) return null;
    const summary = await openWorkspace(win);
    if (summary) {
      upsertLegacyWorkspace(summary);
      pushWorkspaceState();
    }
    return summary;
  });

  defineHandler('workspace:list', async ([root]) => {
    if (typeof root === 'string' && root.length > 0) {
      const summary = await summarizeWorkspace(root);
      upsertLegacyWorkspace(summary);
      pushWorkspaceState();
      return summary;
    }
    return getCurrentWorkspace();
  });

  defineHandler('workspaces:list', () => snapshot());

  defineHandler('workspaces:create', async ([payload]) => {
    const p = obj(payload);
    let roots: readonly WorkspaceRootInput[] =
      p.roots === undefined ? [] : arrayOf(p.roots, toRootInput, 'roots');
    // No roots supplied (the "+ New workspace" flow): pop a native folder picker
    // and seed the workspace with the chosen folder. A cancel creates nothing.
    if (roots.length === 0) {
      const win = deps.getMainWindow();
      const picked = win ? await pickWorkspaceRoot(win) : null;
      if (!picked) return null;
      roots = [picked];
    }
    const requested = typeof p.name === 'string' ? p.name.trim() : '';
    const name = requested || roots[0].name;
    const record = await createWorkspaceRecord(name, roots);
    pushWorkspaceState();
    return record;
  });

  defineHandler('workspaces:add-root', async ([payload]) => {
    const p = obj(payload);
    const record = requireRecord(str(p.workspaceId, 'workspaceId'));
    const input =
      typeof p.path === 'string'
        ? {
            name:
              typeof p.name === 'string' && p.name.trim()
                ? p.name
                : path.basename(p.path),
            path: p.path,
          }
        : await (async () => {
            const win = deps.getMainWindow();
            return win ? pickWorkspaceRoot(win) : null;
          })();
    if (!input) return record;
    const root = await summarizeRoot(input);
    const next = {
      ...record,
      roots: [...record.roots, root],
      activeRootId: record.activeRootId ?? root.id,
    };
    workspaceRecords.set(next.id, next);
    if (activeWorkspaceId === next.id) refreshCurrentWorkspace();
    pushWorkspaceState();
    return next;
  });

  defineHandler('workspaces:add-ssh-root', async ([payload]) => {
    const p = obj(payload);
    const record = requireRecord(str(p.workspaceId, 'workspaceId'));
    const connectionId = str(p.connectionId, 'connectionId');
    const info = getConnectionInfo(connectionId);
    const remotePath = str(p.remotePath, 'remotePath').replace(/\/+$/, '') || '/';
    if (!remotePath.startsWith('/')) {
      throw new Error('remotePath must be an absolute POSIX path');
    }
    const rootKey = sshRootKey(connectionId, remotePath);
    const requested = typeof p.name === 'string' ? p.name.trim() : '';
    const name = requested || path.posix.basename(remotePath) || info.label;
    const summary = await summarizeWorkspace(rootKey);
    const root: WorkspaceRootSummary = {
      id: createId('root'),
      name,
      root: rootKey,
      files: summary.files,
      source: summary.source,
      truncated: summary.truncated,
      connection: {
        kind: 'ssh',
        connectionId,
        host: info.host,
        username: info.username,
        remotePath,
      },
    };
    const next = {
      ...record,
      roots: [...record.roots, root],
      activeRootId: record.activeRootId ?? root.id,
    };
    workspaceRecords.set(next.id, next);
    if (activeWorkspaceId === next.id) refreshCurrentWorkspace();
    pushWorkspaceState();
    return next;
  });

  defineHandler('workspaces:remove-root', ([payload]) => {
    const p = obj(payload);
    const workspaceId = str(p.workspaceId, 'workspaceId');
    const rootId = str(p.rootId, 'rootId');
    const record = requireRecord(workspaceId);
    const roots = record.roots.filter((root) => root.id !== rootId);
    if (roots.length === record.roots.length) {
      throw new Error(`workspace root not found: ${rootId}`);
    }
    const activeRootId =
      record.activeRootId === rootId ? (roots[0]?.id ?? null) : record.activeRootId;
    const next = { ...record, roots, activeRootId };
    workspaceRecords.set(next.id, next);
    if (activeWorkspaceId === next.id) refreshCurrentWorkspace();
    pushWorkspaceState();
    return next;
  });

  defineHandler('workspaces:rename', ([payload]) => {
    const p = obj(payload);
    const workspaceId = str(p.workspaceId, 'workspaceId');
    const name = str(p.name, 'name').trim();
    if (!name) throw new Error('workspace name must not be empty');
    const record = requireRecord(workspaceId);
    const next = { ...record, name };
    workspaceRecords.set(next.id, next);
    if (activeWorkspaceId === next.id) refreshCurrentWorkspace();
    pushWorkspaceState();
    return next;
  });

  defineHandler('workspaces:delete', ([payload]) => {
    const p = obj(payload);
    const workspaceId = str(p.workspaceId, 'workspaceId');
    requireRecord(workspaceId);
    workspaceRecords.delete(workspaceId);
    if (activeWorkspaceId === workspaceId) {
      activeWorkspaceId = workspaceRecords.keys().next().value ?? null;
      focusedPaneId = null;
    }
    refreshCurrentWorkspace();
    pushWorkspaceState();
    return snapshot();
  });

  defineHandler('workspaces:set-active', ([payload]) => {
    const p = obj(payload);
    const workspaceId = str(p.workspaceId, 'workspaceId');
    requireRecord(workspaceId);
    activeWorkspaceId = workspaceId;
    focusedPaneId = p.paneId === undefined ? null : str(p.paneId, 'paneId');
    refreshCurrentWorkspace();
    pushWorkspaceState();
    return snapshot();
  });

  defineHandler('workspaces:set-active-root', ([payload]) => {
    const p = obj(payload);
    const workspaceId = str(p.workspaceId, 'workspaceId');
    const rootId = str(p.rootId, 'rootId');
    const record = requireRecord(workspaceId);
    requireRoot(record, rootId);
    const next = { ...record, activeRootId: rootId };
    workspaceRecords.set(next.id, next);
    activeWorkspaceId = workspaceId;
    refreshCurrentWorkspace();
    pushWorkspaceState();
    return snapshot();
  });

  defineHandler('workspaces:reindex', async ([payload]) => {
    const p = obj(payload);
    const rootId = p.rootId === undefined ? undefined : str(p.rootId, 'rootId');
    const record = await reindexRecord(str(p.workspaceId, 'workspaceId'), rootId);
    pushWorkspaceState();
    return record;
  });

  defineHandler('workspaces:read-file', ([file]) => {
    const resolved = requireFileRef(file);
    return readFileForEditor(resolved.root.root, resolved.file.path);
  });

  defineHandler('workspaces:write-file', ([payload]) => {
    const p = obj(payload);
    const resolved = requireFileRef(p.file);
    return writeFileForEditor(
      resolved.root.root,
      resolved.file.path,
      str(p.content, 'content'),
    );
  });

  defineHandler('workspaces:save-as', async ([payload]) => {
    const p = obj(payload);
    const record = requireRecord(str(p.workspaceId, 'workspaceId'));
    const root = requireRoot(record, str(p.rootId, 'rootId'));
    const win = deps.getMainWindow();
    if (!win) return { ok: false };
    const res = await saveAsForEditor(root.root, str(p.content, 'content'), win);
    if (!res.ok) return res;
    return {
      ...res,
      file: { workspaceId: record.id, rootId: root.id, path: res.path },
    } satisfies WorkspaceSaveAsResult;
  });

  defineHandler('workspaces:rank', ([payload]) => {
    const p = obj(payload);
    const record = requireRecord(str(p.workspaceId, 'workspaceId'));
    const root =
      p.rootId === undefined
        ? activeRoot(record)
        : requireRoot(record, str(p.rootId, 'rootId'));
    if (!root) return [];
    if (!isCaptureInput(p.capture)) throw new Error('invalid capture payload');
    // Ranking reads file contents from the local FS; skip it for remote roots.
    if (isSshRootKey(root.root)) return [];
    return rankFiles(root.root, p.capture, root.files);
  });

  defineHandler('workspace:rank', ([capture]) => {
    const { ws } = requireWorkspace();
    if (!isCaptureInput(capture)) throw new Error('invalid capture payload');
    if (isSshRootKey(ws.root)) return [];
    return rankFiles(ws.root, capture, ws.files);
  });

  defineHandler('workspace:read-file', ([rel]) =>
    readFileForEditor(requireWorkspace().root, str(rel, 'path')),
  );

  defineHandler('workspace:read-media', ([rel]) =>
    readMediaForPreview(requireWorkspace().root, str(rel, 'path')),
  );

  defineHandler('workspace:write-file', ([payload]) => {
    const p = obj(payload);
    return writeFileForEditor(
      requireWorkspace().root,
      str(p.path, 'path'),
      str(p.content, 'content'),
    );
  });

  defineHandler('workspace:save-as', ([payload]) => {
    const content = str(obj(payload).content, 'content');
    const win = deps.getMainWindow();
    if (!win) return { ok: false };
    return saveAsForEditor(requireWorkspace().root, content, win);
  });
}
