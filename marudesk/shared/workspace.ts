export type FileEntry = {
  path: string;
  size: number;
};

export type WorkspaceId = string;
export type WorkspaceRootId = string;
export type WorkspacePaneId = string;

export const SYSTEM_WORKSPACE_ID: WorkspaceId = 'system';

export type WorkspaceSummary = {
  root: string;
  name: string;
  files: FileEntry[];
  source: 'git' | 'walk';
  truncated: boolean;
};

export type WorkspaceRootInput = {
  name: string;
  path: string;
};

export type WorkspaceRootSummary = {
  id: WorkspaceRootId;
  name: string;
  root: string;
  files: FileEntry[];
  source: 'git' | 'walk';
  truncated: boolean;
};

export type WorkspaceRecord = {
  id: WorkspaceId;
  name: string;
  roots: WorkspaceRootSummary[];
  activeRootId: WorkspaceRootId | null;
};

export type WorkspaceSnapshot = {
  revision: number;
  workspaces: WorkspaceRecord[];
  activeWorkspaceId: WorkspaceId | null;
  focusedWorkspaceId: WorkspaceId | null;
  focusedPaneId: WorkspacePaneId | null;
};

export type WorkspaceFileRef = {
  workspaceId: WorkspaceId;
  rootId: WorkspaceRootId;
  path: string;
};

export type RankedFile = {
  path: string;
  score: number;
  matches: string[];
};

export type CaptureInput = {
  tagName?: string;
  selector?: string;
  text?: string;
  attributes?: Record<string, string>;
};

export type WorkspaceImageMediaType =
  | 'image/avif'
  | 'image/bmp'
  | 'image/gif'
  | 'image/jpeg'
  | 'image/png'
  | 'image/webp'
  | 'image/x-icon';

export function imageMediaTypeForPath(
  relPath: string,
): WorkspaceImageMediaType | null {
  const dot = relPath.lastIndexOf('.');
  const ext = dot >= 0 ? relPath.slice(dot + 1).toLowerCase() : '';
  switch (ext) {
    case 'avif':
      return 'image/avif';
    case 'bmp':
      return 'image/bmp';
    case 'gif':
      return 'image/gif';
    case 'ico':
      return 'image/x-icon';
    case 'jpeg':
    case 'jpg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    default:
      return null;
  }
}

/** Result of `workspace:read-file`: previewable content, or why it can't open. */
export type ReadFileResult =
  | { ok: true; kind: 'text'; content: string }
  | {
      ok: true;
      kind: 'image';
      mediaType: WorkspaceImageMediaType;
      dataUrl: string;
      size: number;
    }
  | { ok: false; reason: 'too-large' | 'binary' | 'not-a-file'; size?: number };

/**
 * Max size of a file the Monaco editor will open (bytes). Shared so the
 * main-process guard and the renderer's "too large" message agree on the number.
 */
export const MAX_EDITOR_FILE_SIZE = 2 * 1024 * 1024;

/** Result of `workspace:write-file` (throws on failure, so always ok here). */
export type WriteFileResult = { ok: true };

/**
 * Result of `workspace:save-as`: the new workspace-relative path on success, or
 * a (possibly canceled) failure. Unlike the throwing writes, a canceled dialog
 * or an out-of-workspace target returns `{ ok: false }` rather than throwing.
 */
export type SaveAsResult =
  | { ok: true; path: string }
  | { ok: false; reason?: string };

export type WorkspaceSaveAsResult =
  | { ok: true; path: string; file: WorkspaceFileRef }
  | { ok: false; reason?: string };

/**
 * Result of the mutating workspace ops (create/rename/move/copy). They throw on
 * failure; on success `path` is the new workspace-relative path of the item.
 */
export type MutateResult = { ok: true; path: string };

export type CreateKind = 'file' | 'dir';

export function workspaceFileKey(file: WorkspaceFileRef): string {
  return `${file.workspaceId}:${file.rootId}:${file.path}`;
}

export function workspaceFileLabel(
  workspace: WorkspaceRecord,
  file: WorkspaceFileRef,
  includeWorkspace = false,
): string {
  const root = workspace.roots.find((entry) => entry.id === file.rootId);
  const rootName = root?.name ?? file.rootId;
  return includeWorkspace
    ? `${workspace.name} / ${rootName} / ${file.path}`
    : `${rootName} / ${file.path}`;
}
