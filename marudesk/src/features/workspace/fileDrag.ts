import type { WorkspaceFileRef } from '../../../shared/workspace';
import { useTabsStore } from '../tabs/store';

/**
 * Dragging a file from the explorer onto the canvas (or a grid pane) opens it as
 * an editor panel. The drag carries a serialized file reference under this MIME;
 * the drop target parses it and creates an editor tab (positioned at the drop on
 * the canvas, or split into the pane in classic).
 */
export const FILE_DND_MIME = 'application/x-marudesk-file';

export type FileDragPayload = { file: WorkspaceFileRef } | { path: string };

/** Serialize a workspace file ref (or bare path) for a drag's dataTransfer. */
export function serializeFileDrag(ref: WorkspaceFileRef | string): string {
  return JSON.stringify(typeof ref === 'string' ? { path: ref } : { file: ref });
}

/** Parse a file-drag payload, or null if the data isn't a valid ref. */
export function parseFileDrag(data: string): FileDragPayload | null {
  try {
    const o = JSON.parse(data) as Record<string, unknown>;
    if (typeof o.path === 'string') return { path: o.path };
    if (o.file && typeof o.file === 'object') {
      const f = o.file as Record<string, unknown>;
      if (
        typeof f.workspaceId === 'string' &&
        typeof f.rootId === 'string' &&
        typeof f.path === 'string'
      ) {
        return { file: { workspaceId: f.workspaceId, rootId: f.rootId, path: f.path } };
      }
    }
  } catch {
    // not our payload
  }
  return null;
}

/**
 * Open a dragged file as a NEW editor tab and resolve its tab id. Goes through
 * `browser:tabs-new` directly (not the renderer dedupe in editor/store.openFile)
 * so a drop always materializes a card the caller can position. The new tab
 * becomes the active tab, so we read it back as the id.
 */
export async function openFileDragAsTab(payload: FileDragPayload): Promise<string | null> {
  const arg =
    'file' in payload
      ? { kind: 'editor' as const, file: payload.file, workspaceId: payload.file.workspaceId }
      : { kind: 'editor' as const, path: payload.path };
  try {
    await window.marudesk.invoke('browser:tabs-new', arg);
  } catch {
    return null;
  }
  return useTabsStore.getState().activeTabId;
}
