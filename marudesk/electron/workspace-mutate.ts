import { shell } from 'electron';
import fs from 'node:fs/promises';
import type { CreateKind, MutateResult } from '../shared/workspace';
import {
  assertRealInsideRoot,
  assertRealParentInsideRoot,
  lstatOrNull,
  resolveWorkspacePath,
} from './fs-safe';
import { defineHandler, requireWorkspace } from './ipc/define-handler';
import { enumOf, obj, str } from './ipc/validate';
import { isSshRootKey } from '../shared/ssh';
import {
  sshCopyEntry,
  sshCreateEntry,
  sshDeleteEntry,
  sshMoveEntry,
  sshRenameEntry,
} from './ssh/ssh-workspace';

/**
 * Mutating workspace filesystem ops behind validated IPC channels. Every path
 * is routed through resolveWorkspacePath (rejects absolute / null-byte / ':' /
 * traversal) and every source is lstat-checked to refuse symlinks, so a rename/
 * move/copy/delete can never act on or escape via a link. Deletes go to the OS
 * trash (recoverable), matching VSCode.
 */

function baseOf(rel: string): string {
  return rel.split('/').pop() ?? rel;
}

function parentOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i >= 0 ? rel.slice(0, i) : '';
}

function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** A single path segment: no separators, null, ':' (drive/ADS), or '.'/'..'. */
function assertValidName(name: string): string {
  if (name.length === 0) throw new Error('marudesk: name must not be empty');
  if (name.length > 255) throw new Error('marudesk: name is too long');
  if (/[/\\\0:]/.test(name)) {
    throw new Error('marudesk: name must not contain / \\ : or null');
  }
  if (name === '.' || name === '..') throw new Error('marudesk: invalid name');
  if (/^\s|[\s.]$/.test(name)) {
    throw new Error(
      'marudesk: name must not start with a space or end with a space or dot',
    );
  }
  // Windows reserved device names (also matched with an extension, e.g. nul.txt).
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name)) {
    throw new Error('marudesk: name is a reserved device name');
  }
  return name;
}

async function createEntry(
  root: string,
  parentPath: string,
  name: string,
  kind: CreateKind,
): Promise<MutateResult> {
  if (isSshRootKey(root)) return sshCreateEntry(root, parentPath, name, kind);
  const safeName = assertValidName(name);
  if (parentPath) resolveWorkspacePath(root, parentPath);
  const { rel, abs } = resolveWorkspacePath(root, joinRel(parentPath, safeName));
  if (await lstatOrNull(abs)) {
    throw new Error(`marudesk: already exists: ${rel}`);
  }
  // Parent must exist and resolve inside root (rejects a symlinked ancestor).
  await assertRealParentInsideRoot(root, abs);
  if (kind === 'dir') {
    await fs.mkdir(abs, { recursive: false });
  } else {
    const fh = await fs.open(abs, 'wx');
    await fh.close();
  }
  return { ok: true, path: rel };
}

async function renameEntry(
  root: string,
  relPath: string,
  newName: string,
): Promise<MutateResult> {
  if (isSshRootKey(root)) return sshRenameEntry(root, relPath, newName);
  const safeName = assertValidName(newName);
  const { rel: srcRel, abs: srcAbs } = resolveWorkspacePath(root, relPath);
  if (!(await lstatOrNull(srcAbs))) {
    throw new Error(`marudesk: not found: ${srcRel}`);
  }
  // Refuse a symlink target and any symlinked ancestor (realpath outside root).
  await assertRealInsideRoot(root, srcAbs);
  const { rel: destRel, abs: destAbs } = resolveWorkspacePath(
    root,
    joinRel(parentOf(srcRel), safeName),
  );
  if (destRel === srcRel) return { ok: true, path: srcRel };
  // A case-only rename targets the same file on a case-insensitive FS, so don't
  // treat its own existence as a collision.
  const caseOnly = destRel.toLowerCase() === srcRel.toLowerCase();
  if (!caseOnly && (await lstatOrNull(destAbs))) {
    throw new Error(`marudesk: already exists: ${destRel}`);
  }
  await assertRealParentInsideRoot(root, destAbs);
  await fs.rename(srcAbs, destAbs);
  return { ok: true, path: destRel };
}

async function deleteEntry(root: string, relPath: string): Promise<MutateResult> {
  if (isSshRootKey(root)) return sshDeleteEntry(root, relPath);
  const { rel, abs } = resolveWorkspacePath(root, relPath);
  if (!(await lstatOrNull(abs))) throw new Error(`marudesk: not found: ${rel}`);
  // Refuse a symlink target and any symlinked ancestor, so a delete can never
  // trash a file whose real location is outside the workspace.
  await assertRealInsideRoot(root, abs);
  await shell.trashItem(abs);
  return { ok: true, path: rel };
}

async function moveEntry(
  root: string,
  fromRel: string,
  toDir: string,
): Promise<MutateResult> {
  if (isSshRootKey(root)) return sshMoveEntry(root, fromRel, toDir);
  const { rel: srcRel, abs: srcAbs } = resolveWorkspacePath(root, fromRel);
  if (!(await lstatOrNull(srcAbs))) {
    throw new Error(`marudesk: not found: ${srcRel}`);
  }
  await assertRealInsideRoot(root, srcAbs);
  if (toDir) resolveWorkspacePath(root, toDir);
  const { rel: destRel, abs: destAbs } = resolveWorkspacePath(
    root,
    joinRel(toDir, baseOf(srcRel)),
  );
  if (destRel === srcRel) return { ok: true, path: srcRel };
  if (destRel.startsWith(srcRel + '/')) {
    throw new Error('marudesk: cannot move a folder into itself');
  }
  if (await lstatOrNull(destAbs)) {
    throw new Error(`marudesk: already exists: ${destRel}`);
  }
  await assertRealParentInsideRoot(root, destAbs);
  await fs.rename(srcAbs, destAbs);
  return { ok: true, path: destRel };
}

async function uniqueDest(
  root: string,
  destRel: string,
): Promise<{ rel: string; abs: string }> {
  const dir = parentOf(destRel);
  const base = baseOf(destRel);
  const dot = base.lastIndexOf('.');
  const hasExt = dot > 0;
  const stem = hasExt ? base.slice(0, dot) : base;
  const ext = hasExt ? base.slice(dot) : '';
  for (let i = 0; i < 100; i++) {
    const candidate =
      i === 0
        ? destRel
        : joinRel(dir, `${stem}${i === 1 ? ' copy' : ` copy ${i}`}${ext}`);
    const resolved = resolveWorkspacePath(root, candidate);
    if (!(await lstatOrNull(resolved.abs))) return resolved;
  }
  throw new Error('marudesk: too many copies');
}

async function copyEntry(
  root: string,
  fromRel: string,
  toDir: string,
): Promise<MutateResult> {
  if (isSshRootKey(root)) return sshCopyEntry(root, fromRel, toDir);
  const { rel: srcRel, abs: srcAbs } = resolveWorkspacePath(root, fromRel);
  if (!(await lstatOrNull(srcAbs))) {
    throw new Error(`marudesk: not found: ${srcRel}`);
  }
  await assertRealInsideRoot(root, srcAbs);
  if (toDir) resolveWorkspacePath(root, toDir);
  const baseDestRel = joinRel(toDir, baseOf(srcRel));
  if (baseDestRel.startsWith(srcRel + '/')) {
    throw new Error('marudesk: cannot copy a folder into itself');
  }
  const { rel: destRel, abs: destAbs } = await uniqueDest(root, baseDestRel);
  await assertRealParentInsideRoot(root, destAbs);
  // Skip symlinks inside the copied tree so a copy can't plant an unvetted link
  // pointing outside the workspace (the source root is symlink-refused above).
  await fs.cp(srcAbs, destAbs, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: async (s) => !(await fs.lstat(s)).isSymbolicLink(),
  });
  return { ok: true, path: destRel };
}

export function registerWorkspaceMutateHandlers(): void {
  defineHandler('workspace:create', ([payload]) => {
    const p = obj(payload);
    const kind = enumOf(p.kind, ['file', 'dir'] as const, 'kind');
    const parentPath = typeof p.parentPath === 'string' ? p.parentPath : '';
    return createEntry(
      requireWorkspace().root,
      parentPath,
      str(p.name, 'name'),
      kind,
    );
  });

  defineHandler('workspace:rename', ([payload]) => {
    const p = obj(payload);
    return renameEntry(
      requireWorkspace().root,
      str(p.path, 'path'),
      str(p.newName, 'newName'),
    );
  });

  defineHandler('workspace:delete', ([payload]) => {
    const p = obj(payload);
    return deleteEntry(requireWorkspace().root, str(p.path, 'path'));
  });

  defineHandler('workspace:move', ([payload]) => {
    const p = obj(payload);
    const toDir = typeof p.toDir === 'string' ? p.toDir : '';
    return moveEntry(requireWorkspace().root, str(p.from, 'from'), toDir);
  });

  defineHandler('workspace:copy', ([payload]) => {
    const p = obj(payload);
    const toDir = typeof p.toDir === 'string' ? p.toDir : '';
    return copyEntry(requireWorkspace().root, str(p.from, 'from'), toDir);
  });

  defineHandler('workspace:reveal', ([payload]) => {
    const p = obj(payload);
    const root = requireWorkspace().root;
    if (isSshRootKey(root)) {
      // No local Finder/Explorer to reveal a remote path in.
      throw new Error('marudesk: reveal is not available for remote workspaces');
    }
    const { abs } = resolveWorkspacePath(root, str(p.path, 'path'));
    shell.showItemInFolder(abs);
    return { ok: true };
  });
}
