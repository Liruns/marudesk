import fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Canonical workspace path-safety helpers. Every main-process file operation
 * that acts on a renderer-supplied path MUST go through here:
 *   1. resolveWorkspacePath — reject absolute paths, null bytes, and traversal
 *      that escapes the workspace root.
 *   2. assertRealInsideRoot — refuse symlinks / paths whose realpath leaves the
 *      root, so a symlink can never be used to read or write outside.
 * Centralizing this keeps the security contract auditable in one file rather
 * than re-derived per feature.
 */

/** True when `abs` is the root itself or strictly contained within it. */
export function isInsideRoot(root: string, abs: string): boolean {
  const rRoot = path.resolve(root);
  const rAbs = path.resolve(abs);
  return rAbs === rRoot || rAbs.startsWith(rRoot + path.sep);
}

/**
 * Validate and resolve a workspace-relative path. Throws on anything unsafe;
 * returns the normalized POSIX-relative form and the absolute path.
 */
export function resolveWorkspacePath(
  root: string,
  rel: string,
): { rel: string; abs: string } {
  if (typeof rel !== 'string' || rel.length === 0) {
    throw new Error('marudesk: path must be a non-empty string');
  }
  if (rel.includes('\0')) {
    throw new Error('marudesk: path must not contain null bytes');
  }
  if (path.isAbsolute(rel)) {
    throw new Error(`marudesk: path must be relative: ${rel}`);
  }
  // Renderer paths are POSIX by contract (see shared/browser.ts), so a
  // backslash is always treated as a separator — intentional, lossy on the
  // rare POSIX filename that contains a literal backslash.
  const normalized = rel.replace(/\\/g, '/').replace(/\/+/g, '/');
  // A ':' can only be an NTFS alternate data stream (file.txt:stream,
  // file.txt::$DATA) or a drive-relative specifier (C:foo) — absolute drive
  // paths were already rejected above. None are valid workspace-relative
  // paths; refuse them so the validated path maps to exactly one OS handle.
  if (normalized.includes(':')) {
    throw new Error(`marudesk: path must not contain ':': ${rel}`);
  }
  const abs = path.resolve(root, normalized);
  if (!isInsideRoot(root, abs)) {
    throw new Error(`marudesk: path escapes workspace: ${rel}`);
  }
  return { rel: normalized, abs };
}

/**
 * For a path that exists: refuse symlinks and confirm its realpath stays inside
 * the workspace. Call after resolveWorkspacePath and after confirming the path
 * exists (it lstats `abs`).
 */
export async function assertRealInsideRoot(
  root: string,
  abs: string,
): Promise<void> {
  const lst = await fs.lstat(abs);
  if (lst.isSymbolicLink()) {
    throw new Error('marudesk: refuses to follow symlink');
  }
  const real = await fs.realpath(abs);
  if (!isInsideRoot(root, real)) {
    throw new Error('marudesk: path resolves outside workspace');
  }
}

/**
 * For a path that does NOT exist yet (a create/rename/move/copy destination):
 * confirm its parent directory's realpath stays inside the workspace, so a
 * symlinked ancestor can't redirect the write outside the root.
 */
export async function assertRealParentInsideRoot(
  root: string,
  abs: string,
): Promise<void> {
  const real = await fs.realpath(path.dirname(abs));
  if (!isInsideRoot(root, real)) {
    throw new Error('marudesk: destination resolves outside workspace');
  }
}

/**
 * Write `content` to `abs` atomically: an exclusive-create ('wx') sibling temp
 * with an unguessable name (so a pre-planted symlink at the temp path can't
 * redirect the write), then a rename (which replaces a link in place rather
 * than following it). Cleans up the temp on failure. Callers must validate
 * `abs` (resolveWorkspacePath + the relevant realpath assertion) first — this
 * helper only owns the write mechanics, not path safety.
 */
export async function atomicWriteFile(
  abs: string,
  content: string,
): Promise<void> {
  const tmp = `${abs}.marudesk-tmp-${randomBytes(6).toString('hex')}`;
  const fh = await fs.open(tmp, 'wx');
  try {
    await fh.writeFile(content, 'utf8');
  } finally {
    await fh.close();
  }
  try {
    await fs.rename(tmp, abs);
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/** lstat that yields null instead of throwing when the path doesn't exist. */
export async function lstatOrNull(abs: string): Promise<Stats | null> {
  try {
    return await fs.lstat(abs);
  } catch {
    return null;
  }
}
