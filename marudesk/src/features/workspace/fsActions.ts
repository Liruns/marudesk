import { useWorkspaceStore } from './store';
import { useEditorStore } from '../editor/store';
import { toMessage } from '../../lib/toMessage';

/**
 * Orchestration for the explorer's mutating actions: each calls a validated
 * workspace:* channel, then reindexes so the tree reflects disk. Errors are
 * surfaced (not swallowed) — inline edits keep their input open on failure so
 * the user can correct the name.
 */

async function refresh(): Promise<void> {
  await useWorkspaceStore.getState().reindex();
}

/** Commit a new file/folder. Returns the new path, or null on failure. */
export async function commitCreate(
  parentDir: string,
  name: string,
  kind: 'file' | 'dir',
): Promise<string | null> {
  try {
    const res = await window.marudesk.invoke('workspace:create', {
      parentPath: parentDir,
      name,
      kind,
    });
    await refresh();
    const ws = useWorkspaceStore.getState();
    ws.cancelPending();
    if (kind === 'file') {
      ws.selectFile(res.path);
      await useEditorStore.getState().openFile(res.path);
    } else {
      ws.expandDir(res.path);
    }
    return res.path;
  } catch (err) {
    window.alert(toMessage(err));
    return null;
  }
}

/** Commit a rename. Returns the new path, or null on failure. */
export async function commitRename(
  path: string,
  newName: string,
): Promise<string | null> {
  try {
    const res = await window.marudesk.invoke('workspace:rename', {
      path,
      newName,
    });
    await refresh();
    const ws = useWorkspaceStore.getState();
    ws.cancelPending();
    ws.selectFile(res.path);
    return res.path;
  } catch (err) {
    window.alert(toMessage(err));
    return null;
  }
}

export async function deletePath(path: string): Promise<void> {
  if (!window.confirm(`Move "${path}" to the trash?`)) return;
  try {
    await window.marudesk.invoke('workspace:delete', { path });
    await refresh();
  } catch (err) {
    window.alert(toMessage(err));
  }
}

export async function pasteInto(dir: string): Promise<void> {
  const ws = useWorkspaceStore.getState();
  const clip = ws.clipboard;
  if (!clip) return;
  try {
    if (clip.mode === 'cut') {
      await window.marudesk.invoke('workspace:move', { from: clip.path, toDir: dir });
      ws.clearClipboard();
    } else {
      await window.marudesk.invoke('workspace:copy', { from: clip.path, toDir: dir });
    }
    await refresh();
  } catch (err) {
    window.alert(toMessage(err));
  }
}

/**
 * Move one or more entries into a directory (drag & drop in the tree). The
 * caller (the tree) has already moved the nodes optimistically; on any failure
 * we reindex so the view snaps back to disk truth. Returns true on full success.
 */
export async function moveInto(paths: readonly string[], toDir: string): Promise<boolean> {
  try {
    for (const from of paths) {
      await window.marudesk.invoke('workspace:move', { from, toDir });
    }
    await refresh();
    return true;
  } catch (err) {
    window.alert(toMessage(err));
    await refresh();
    return false;
  }
}

export async function revealPath(path: string): Promise<void> {
  try {
    await window.marudesk.invoke('workspace:reveal', { path });
  } catch (err) {
    window.alert(toMessage(err));
  }
}

export async function copyAbsolutePath(path: string): Promise<void> {
  const root = useWorkspaceStore.getState().summary?.root;
  if (!root) return;
  // Windows roots use backslashes / carry a drive letter; POSIX roots use '/'.
  const isWindows = /\\/.test(root) || /^[a-zA-Z]:/.test(root);
  const sep = isWindows ? '\\' : '/';
  const abs = root.replace(/[\\/]+$/, '') + sep + path.split('/').join(sep);
  await writeClipboard(abs);
}

export async function copyRelativePath(path: string): Promise<void> {
  await writeClipboard(path);
}

async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    window.alert(toMessage(err));
  }
}
