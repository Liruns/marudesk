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
import { MAX_FILE_SIZE } from './workspace-config';

export { readFileForEditor } from './workspace-read';

export async function readFileSafe(
  root: string,
  relPath: string,
  maxSize = MAX_FILE_SIZE,
): Promise<string> {
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
  if (st.size > maxSize) {
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

export async function writeFileForEditor(
  root: string,
  rel: string,
  content: string,
): Promise<WriteFileResult> {
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
    return { ok: false, reason: 'File must be saved inside the workspace.' };
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
