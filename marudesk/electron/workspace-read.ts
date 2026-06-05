import fs from 'node:fs/promises';
import {
  imageMediaTypeForPath,
  mediaMediaTypeForPath,
  MAX_EDITOR_FILE_SIZE,
  MAX_MEDIA_PREVIEW_SIZE,
  type ReadFileResult,
  type ReadMediaResult,
} from '../shared/workspace';
import { isSshRootKey } from '../shared/ssh';
import { isInsideRoot, resolveWorkspacePath } from './fs-safe';
import { sshReadFileForEditor, sshReadMediaForPreview } from './ssh/ssh-workspace';

export async function readFileForEditor(
  root: string,
  rel: string,
): Promise<ReadFileResult> {
  if (isSshRootKey(root)) return sshReadFileForEditor(root, rel);
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

/**
 * Read an image/video file as a data URL for inline chat preview (generated
 * media artifacts). Uses the same symlink/inside-root guards as the editor read
 * but a larger size cap ({@link MAX_MEDIA_PREVIEW_SIZE}) and accepts video
 * containers. Non-media paths return `unsupported` rather than text bytes.
 */
export async function readMediaForPreview(
  root: string,
  rel: string,
): Promise<ReadMediaResult> {
  if (isSshRootKey(root)) return sshReadMediaForPreview(root, rel);
  const media = mediaMediaTypeForPath(rel);
  if (!media) return { ok: false, reason: 'unsupported' };
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
  if (lst.size > MAX_MEDIA_PREVIEW_SIZE) {
    return { ok: false, reason: 'too-large', size: lst.size };
  }
  const buf = await fs.readFile(abs);
  return {
    ok: true,
    kind: media.kind,
    mediaType: media.mediaType,
    dataUrl: `data:${media.mediaType};base64,${buf.toString('base64')}`,
    size: lst.size,
  };
}
