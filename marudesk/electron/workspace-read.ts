import fs from 'node:fs/promises';
import {
  imageMediaTypeForPath,
  MAX_EDITOR_FILE_SIZE,
  type ReadFileResult,
} from '../shared/workspace';
import { isInsideRoot, resolveWorkspacePath } from './fs-safe';

export async function readFileForEditor(
  root: string,
  rel: string,
): Promise<ReadFileResult> {
  const { abs } = resolveWorkspacePath(root, rel);
  const lst = await fs.lstat(abs);
  if (lst.isSymbolicLink()) {
    throw new Error('marudesk: refuses to follow symlink');
  }
  if (!lst.isFile()) {
    return { ok: false, reason: 'not-a-file' };
  }
  const real = await fs.realpath(abs);
  if (!isInsideRoot(root, real)) {
    throw new Error('marudesk: path resolves outside workspace');
  }
  if (lst.size > MAX_EDITOR_FILE_SIZE) {
    return { ok: false, reason: 'too-large', size: lst.size };
  }

  const imageMediaType = imageMediaTypeForPath(rel);
  const buf = await fs.readFile(abs);
  if (imageMediaType) {
    return {
      ok: true,
      kind: 'image',
      mediaType: imageMediaType,
      dataUrl: `data:${imageMediaType};base64,${buf.toString('base64')}`,
      size: lst.size,
    };
  }

  if (buf.subarray(0, 8192).includes(0)) {
    return { ok: false, reason: 'binary' };
  }
  return { ok: true, kind: 'text', content: buf.toString('utf8') };
}
