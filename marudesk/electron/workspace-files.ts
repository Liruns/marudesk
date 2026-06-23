import { dialog, type BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  MAX_EDITOR_FILE_SIZE,
  type SaveAsResult,
  type WriteFileResult,
} from '../shared/workspace';
import {
  assertRealParentInsideRoot,
  atomicWriteFile,
  isInsideRoot,
  lstatOrNull,
  resolveWorkspacePath,
} from './fs-safe';
import { MAX_AGENT_FILE_SIZE, MAX_FILE_SIZE } from './workspace-config';
import { isSshRootKey } from '../shared/ssh';
import { sshWriteFileForEditor } from './ssh/ssh-workspace';

export { readFileForEditor, readMediaForPreview } from './workspace-read';

/**
 * Resolve `relPath` inside `root` and enforce the shared read guards: refuse
 * symlinks, non-files, and anything whose real path escapes the workspace.
 * Returns the validated absolute path and on-disk size for the caller to read.
 */
async function assertSafeFile(
  root: string,
  relPath: string,
): Promise<{ abs: string; size: number }> {
  const { abs } = resolveWorkspacePath(root, relPath);
  const st = await fs.lstat(abs);
  if (st.isSymbolicLink()) {
    throw new Error(`marudesk: refuse to follow symlink: ${relPath}`);
  }
  if (!st.isFile()) {
    throw new Error(`marudesk: not a file: ${relPath}`);
  }
  const real = await fs.realpath(abs);
  if (!isInsideRoot(root, real)) {
    throw new Error(
      `marudesk: refuse to follow symlink to outside workspace: ${relPath}`,
    );
  }
  return { abs, size: st.size };
}

export async function readFileSafe(
  root: string,
  relPath: string,
  maxSize = MAX_FILE_SIZE,
): Promise<string> {
  const { abs, size } = await assertSafeFile(root, relPath);
  if (size > maxSize) {
    const fh = await fs.open(abs, 'r');
    try {
      const buf = Buffer.alloc(maxSize);
      await fh.read(buf, 0, maxSize, 0);
      return buf.toString('utf8');
    } finally {
      await fh.close();
    }
  }
  return fs.readFile(abs, 'utf8');
}

export type WindowedRead = {
  /** The decoded file text (full file, or a clean line-bounded prefix). */
  content: string;
  /** True size of the file on disk in bytes. */
  size: number;
  /** True when the file exceeded `maxBytes` and `content` is a prefix only. */
  truncated: boolean;
};

/**
 * Read a file for the agent as a line-addressable document. Reads the whole
 * file when it fits within `maxBytes`; for larger files it reads a prefix and
 * drops the trailing partial line, so the returned text never ends mid-line or
 * splits a UTF-8 multibyte character (which byte-window truncation would). The
 * caller pages over `content` by line offset and uses it as the staleness/edit
 * anchor, so the view, the hash, and an edit all see the same bytes.
 */
export async function readFileWindow(
  root: string,
  relPath: string,
  maxBytes = MAX_AGENT_FILE_SIZE,
): Promise<WindowedRead> {
  const { abs, size } = await assertSafeFile(root, relPath);
  if (size <= maxBytes) {
    return { content: await fs.readFile(abs, 'utf8'), size, truncated: false };
  }
  const fh = await fs.open(abs, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    let text = buf.subarray(0, bytesRead).toString('utf8');
    // Drop the trailing partial line (which also carries any split multibyte
    // char at the byte boundary) so the prefix ends cleanly on a newline. When
    // the prefix has no newline at all (one huge line), just drop a trailing
    // replacement char left by a split multibyte sequence.
    const lastNl = text.lastIndexOf('\n');
    if (lastNl >= 0) text = text.slice(0, lastNl);
    else if (text.endsWith('�')) text = text.slice(0, -1);
    return { content: text, size, truncated: true };
  } finally {
    await fh.close();
  }
}

export async function writeFileForEditor(
  root: string,
  rel: string,
  content: string,
): Promise<WriteFileResult> {
  if (isSshRootKey(root)) return sshWriteFileForEditor(root, rel, content);
  if (typeof content !== 'string') {
    throw new Error('marudesk: content must be a string');
  }
  if (content.length > MAX_EDITOR_FILE_SIZE) {
    throw new Error('marudesk: content exceeds the editor size limit');
  }
  const { abs } = resolveWorkspacePath(root, rel);
  const lst = await fs.lstat(abs);
  if (lst.isSymbolicLink()) {
    throw new Error('marudesk: refuses to follow symlink');
  }
  if (!lst.isFile()) {
    throw new Error('marudesk: not a regular file');
  }
  const real = await fs.realpath(abs);
  if (!isInsideRoot(root, real)) {
    throw new Error('marudesk: path resolves outside workspace');
  }
  await atomicWriteFile(abs, content);
  return { ok: true };
}

export async function saveAsForEditor(
  root: string,
  content: string,
  parentWindow: BrowserWindow,
): Promise<SaveAsResult> {
  if (isSshRootKey(root)) {
    // Save As needs a native destination picker rooted on the local FS; there's
    // no equivalent for a remote root yet. Use the editor's plain Save instead.
    return { ok: false, reason: 'remote-unavailable' };
  }
  if (typeof content !== 'string') {
    throw new Error('marudesk: content must be a string');
  }
  if (content.length > MAX_EDITOR_FILE_SIZE) {
    throw new Error('marudesk: content exceeds the editor size limit');
  }
  const result = await dialog.showSaveDialog(parentWindow, {
    title: 'Save As',
    defaultPath: root,
  });
  if (result.canceled || !result.filePath) return { ok: false };

  const chosen = path.resolve(result.filePath);
  if (!isInsideRoot(root, chosen)) {
    return { ok: false, reason: 'outside-workspace' };
  }
  const rel = path.relative(root, chosen).replace(/\\/g, '/');
  const { rel: safeRel, abs } = resolveWorkspacePath(root, rel);

  const existing = await lstatOrNull(abs);
  if (existing) {
    if (existing.isSymbolicLink()) {
      throw new Error('marudesk: refuses to follow symlink');
    }
    if (!existing.isFile()) {
      throw new Error('marudesk: not a regular file');
    }
    const real = await fs.realpath(abs);
    if (!isInsideRoot(root, real)) {
      throw new Error('marudesk: path resolves outside workspace');
    }
  } else {
    await assertRealParentInsideRoot(root, abs);
  }

  await atomicWriteFile(abs, content);
  return { ok: true, path: safeRel };
}
