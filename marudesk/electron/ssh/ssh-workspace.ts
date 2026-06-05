import path from 'node:path/posix';
import {
  imageMediaTypeForPath,
  mediaMediaTypeForPath,
  MAX_EDITOR_FILE_SIZE,
  MAX_MEDIA_PREVIEW_SIZE,
  type CreateKind,
  type FileEntry,
  type MutateResult,
  type ReadFileResult,
  type ReadMediaResult,
  type WorkspaceSummary,
  type WriteFileResult,
} from '../../shared/workspace';
import { IGNORE_DIRS, MAX_FILES } from '../workspace-config';
import { ensureSftp, execCommand } from './connection-manager';
import {
  assertRealInsideRoot,
  assertRealParentInsideRoot,
  assertValidRemoteName,
  isInsideRootPosix,
  lstat,
  lstatOrNull,
  mapLimit,
  parseRemoteRoot,
  readFile,
  readdir,
  realpath,
  rename,
  resolveRemotePath,
  rmdir,
  unlink,
  writeBufferExclusive,
  writeFileAtomic,
  createFileExclusive,
  mkdir,
  type RemoteDirEntry,
} from './sftp';
import type { SFTPWrapper, Stats } from 'ssh2';

/**
 * Remote (SSH/SFTP) backend for the workspace file ops. Each entry point takes
 * the `ssh://` root key the renderer also uses for local roots, parses it back
 * to a connection + remote path, and mirrors the local module's behavior and
 * result types over SFTP. Path safety lives in ./sftp.
 *
 * Note: remote deletes are permanent (no OS trash on the host); the renderer
 * surfaces this. save-as is not offered for remote roots (it needs a native
 * dialog) — see workspace-files.ts.
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

/** Single-quote a string for safe interpolation into a remote shell command. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function backend(rootKey: string): Promise<{
  sftp: SFTPWrapper;
  connectionId: string;
  remoteRoot: string;
}> {
  const { connectionId, remoteRoot } = parseRemoteRoot(rootKey);
  const sftp = await ensureSftp(connectionId);
  return { sftp, connectionId, remoteRoot };
}

/* ── indexing ────────────────────────────────────────────────────────────── */

export async function sshSummarize(rootKey: string): Promise<WorkspaceSummary> {
  const { sftp, connectionId, remoteRoot } = await backend(rootKey);
  const git = await listGitFiles(sftp, connectionId, remoteRoot);
  const listed = git ?? (await walkFiles(sftp, remoteRoot));
  listed.files.sort((a, b) => a.path.localeCompare(b.path));
  const name = path.basename(remoteRoot) || remoteRoot;
  return {
    root: rootKey,
    name,
    files: listed.files,
    source: listed.source,
    truncated: listed.truncated,
  };
}

async function listGitFiles(
  sftp: SFTPWrapper,
  connectionId: string,
  remoteRoot: string,
): Promise<{ files: FileEntry[]; source: 'git'; truncated: boolean } | null> {
  let stdout: Buffer;
  try {
    const cmd = `git -C ${shellQuote(remoteRoot)} ls-files -z --cached --others --exclude-standard`;
    const result = await execCommand(connectionId, cmd);
    if (result.code !== 0) return null;
    stdout = result.stdout;
  } catch {
    return null;
  }
  const rel = stdout.toString('utf8').split('\0').filter(Boolean);
  if (rel.length === 0) return null;
  const truncated = rel.length > MAX_FILES;
  const sliced = truncated ? rel.slice(0, MAX_FILES) : rel;
  const sized = await mapLimit(sliced, 32, async (r): Promise<FileEntry | null> => {
    const abs = path.resolve(remoteRoot, r);
    if (!isInsideRootPosix(remoteRoot, abs)) return null;
    const st = await lstatOrNull(sftp, abs);
    if (!st || !st.isFile()) return null;
    return { path: r.replace(/\\/g, '/'), size: st.size };
  });
  const files = sized.filter((entry): entry is FileEntry => entry !== null);
  return { files, source: 'git', truncated };
}

async function walkFiles(
  sftp: SFTPWrapper,
  remoteRoot: string,
): Promise<{ files: FileEntry[]; source: 'walk'; truncated: boolean }> {
  const files: FileEntry[] = [];
  let truncated = false;

  async function walk(dir: string): Promise<void> {
    if (truncated) return;
    let entries: RemoteDirEntry[];
    try {
      entries = await readdir(sftp, dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      const name = entry.filename;
      if (entry.attrs.isSymbolicLink()) continue;
      if (entry.attrs.isDirectory()) {
        if (IGNORE_DIRS.has(name)) continue;
        if (name.startsWith('.')) continue;
        await walk(`${dir}/${name}`);
      } else if (entry.attrs.isFile()) {
        const abs = `${dir}/${name}`;
        files.push({ path: path.relative(remoteRoot, abs), size: entry.attrs.size });
        if (files.length >= MAX_FILES) {
          truncated = true;
          return;
        }
      }
    }
  }

  await walk(remoteRoot);
  return { files, source: 'walk', truncated };
}

/* ── reads ───────────────────────────────────────────────────────────────── */

export async function sshReadFileForEditor(
  rootKey: string,
  rel: string,
): Promise<ReadFileResult> {
  const { sftp, remoteRoot } = await backend(rootKey);
  const { abs } = resolveRemotePath(remoteRoot, rel);
  const st = await lstat(sftp, abs);
  if (st.isSymbolicLink()) {
    throw new Error('marudesk: refuses to follow symlink');
  }
  if (!st.isFile()) return { ok: false, reason: 'not-a-file' };
  const real = await realpath(sftp, abs);
  if (!isInsideRootPosix(remoteRoot, real)) {
    throw new Error('marudesk: path resolves outside workspace');
  }
  if (st.size > MAX_EDITOR_FILE_SIZE) {
    return { ok: false, reason: 'too-large', size: st.size };
  }
  const imageMediaType = imageMediaTypeForPath(rel);
  const buf = await readFile(sftp, abs);
  if (imageMediaType) {
    return {
      ok: true,
      kind: 'image',
      mediaType: imageMediaType,
      dataUrl: `data:${imageMediaType};base64,${buf.toString('base64')}`,
      size: st.size,
    };
  }
  if (buf.subarray(0, 8192).includes(0)) {
    return { ok: false, reason: 'binary' };
  }
  return { ok: true, kind: 'text', content: buf.toString('utf8') };
}

export async function sshReadMediaForPreview(
  rootKey: string,
  rel: string,
): Promise<ReadMediaResult> {
  const media = mediaMediaTypeForPath(rel);
  if (!media) return { ok: false, reason: 'unsupported' };
  const { sftp, remoteRoot } = await backend(rootKey);
  const { abs } = resolveRemotePath(remoteRoot, rel);
  const st = await lstat(sftp, abs);
  if (st.isSymbolicLink()) {
    throw new Error('marudesk: refuses to follow symlink');
  }
  if (!st.isFile()) return { ok: false, reason: 'not-a-file' };
  const real = await realpath(sftp, abs);
  if (!isInsideRootPosix(remoteRoot, real)) {
    throw new Error('marudesk: path resolves outside workspace');
  }
  if (st.size > MAX_MEDIA_PREVIEW_SIZE) {
    return { ok: false, reason: 'too-large', size: st.size };
  }
  const buf = await readFile(sftp, abs);
  return {
    ok: true,
    kind: media.kind,
    mediaType: media.mediaType,
    dataUrl: `data:${media.mediaType};base64,${buf.toString('base64')}`,
    size: st.size,
  };
}

/* ── writes ──────────────────────────────────────────────────────────────── */

export async function sshWriteFileForEditor(
  rootKey: string,
  rel: string,
  content: string,
): Promise<WriteFileResult> {
  if (typeof content !== 'string') {
    throw new Error('marudesk: content must be a string');
  }
  if (content.length > MAX_EDITOR_FILE_SIZE) {
    throw new Error('marudesk: content exceeds the editor size limit');
  }
  const { sftp, remoteRoot } = await backend(rootKey);
  const { abs } = resolveRemotePath(remoteRoot, rel);
  const st = await lstat(sftp, abs);
  if (st.isSymbolicLink()) {
    throw new Error('marudesk: refuses to follow symlink');
  }
  if (!st.isFile()) {
    throw new Error('marudesk: not a regular file');
  }
  const real = await realpath(sftp, abs);
  if (!isInsideRootPosix(remoteRoot, real)) {
    throw new Error('marudesk: path resolves outside workspace');
  }
  await writeFileAtomic(sftp, abs, content);
  return { ok: true };
}

/* ── mutations ───────────────────────────────────────────────────────────── */

export async function sshCreateEntry(
  rootKey: string,
  parentPath: string,
  name: string,
  kind: CreateKind,
): Promise<MutateResult> {
  const safeName = assertValidRemoteName(name);
  const { sftp, remoteRoot } = await backend(rootKey);
  if (parentPath) resolveRemotePath(remoteRoot, parentPath);
  const { rel, abs } = resolveRemotePath(remoteRoot, joinRel(parentPath, safeName));
  if (await lstatOrNull(sftp, abs)) {
    throw new Error(`marudesk: already exists: ${rel}`);
  }
  await assertRealParentInsideRoot(sftp, remoteRoot, abs);
  if (kind === 'dir') await mkdir(sftp, abs);
  else await createFileExclusive(sftp, abs);
  return { ok: true, path: rel };
}

export async function sshRenameEntry(
  rootKey: string,
  relPath: string,
  newName: string,
): Promise<MutateResult> {
  const safeName = assertValidRemoteName(newName);
  const { sftp, remoteRoot } = await backend(rootKey);
  const { rel: srcRel, abs: srcAbs } = resolveRemotePath(remoteRoot, relPath);
  if (!(await lstatOrNull(sftp, srcAbs))) {
    throw new Error(`marudesk: not found: ${srcRel}`);
  }
  await assertRealInsideRoot(sftp, remoteRoot, srcAbs);
  const { rel: destRel, abs: destAbs } = resolveRemotePath(
    remoteRoot,
    joinRel(parentOf(srcRel), safeName),
  );
  if (destRel === srcRel) return { ok: true, path: srcRel };
  if (await lstatOrNull(sftp, destAbs)) {
    throw new Error(`marudesk: already exists: ${destRel}`);
  }
  await assertRealParentInsideRoot(sftp, remoteRoot, destAbs);
  await rename(sftp, srcAbs, destAbs);
  return { ok: true, path: destRel };
}

export async function sshDeleteEntry(
  rootKey: string,
  relPath: string,
): Promise<MutateResult> {
  const { sftp, remoteRoot } = await backend(rootKey);
  const { rel, abs } = resolveRemotePath(remoteRoot, relPath);
  const st = await lstatOrNull(sftp, abs);
  if (!st) throw new Error(`marudesk: not found: ${rel}`);
  // Refuse a symlink target and any symlinked ancestor before removing.
  await assertRealInsideRoot(sftp, remoteRoot, abs);
  await removeRecursive(sftp, abs, st);
  return { ok: true, path: rel };
}

async function removeRecursive(
  sftp: SFTPWrapper,
  abs: string,
  st: Stats,
): Promise<void> {
  // Directories recurse; files and symlinks unlink. Children use their own
  // lstat attrs so a symlinked subdir is unlinked, never followed.
  if (st.isDirectory()) {
    const entries = await readdir(sftp, abs);
    for (const entry of entries) {
      await removeRecursive(sftp, `${abs}/${entry.filename}`, entry.attrs);
    }
    await rmdir(sftp, abs);
  } else {
    await unlink(sftp, abs);
  }
}

export async function sshMoveEntry(
  rootKey: string,
  fromRel: string,
  toDir: string,
): Promise<MutateResult> {
  const { sftp, remoteRoot } = await backend(rootKey);
  const { rel: srcRel, abs: srcAbs } = resolveRemotePath(remoteRoot, fromRel);
  if (!(await lstatOrNull(sftp, srcAbs))) {
    throw new Error(`marudesk: not found: ${srcRel}`);
  }
  await assertRealInsideRoot(sftp, remoteRoot, srcAbs);
  if (toDir) resolveRemotePath(remoteRoot, toDir);
  const { rel: destRel, abs: destAbs } = resolveRemotePath(
    remoteRoot,
    joinRel(toDir, baseOf(srcRel)),
  );
  if (destRel === srcRel) return { ok: true, path: srcRel };
  if (destRel.startsWith(srcRel + '/')) {
    throw new Error('marudesk: cannot move a folder into itself');
  }
  if (await lstatOrNull(sftp, destAbs)) {
    throw new Error(`marudesk: already exists: ${destRel}`);
  }
  await assertRealParentInsideRoot(sftp, remoteRoot, destAbs);
  await rename(sftp, srcAbs, destAbs);
  return { ok: true, path: destRel };
}

export async function sshCopyEntry(
  rootKey: string,
  fromRel: string,
  toDir: string,
): Promise<MutateResult> {
  const { sftp, remoteRoot } = await backend(rootKey);
  const { rel: srcRel, abs: srcAbs } = resolveRemotePath(remoteRoot, fromRel);
  const srcStat = await lstatOrNull(sftp, srcAbs);
  if (!srcStat) throw new Error(`marudesk: not found: ${srcRel}`);
  await assertRealInsideRoot(sftp, remoteRoot, srcAbs);
  if (toDir) resolveRemotePath(remoteRoot, toDir);
  const baseDestRel = joinRel(toDir, baseOf(srcRel));
  if (baseDestRel.startsWith(srcRel + '/')) {
    throw new Error('marudesk: cannot copy a folder into itself');
  }
  const { rel: destRel, abs: destAbs } = await uniqueDest(sftp, remoteRoot, baseDestRel);
  await assertRealParentInsideRoot(sftp, remoteRoot, destAbs);
  await copyRecursive(sftp, srcAbs, destAbs, srcStat);
  return { ok: true, path: destRel };
}

async function copyRecursive(
  sftp: SFTPWrapper,
  src: string,
  dest: string,
  st: Stats,
): Promise<void> {
  // Mirror the local copy's symlink skip so a copy can't plant an unvetted link.
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    await mkdir(sftp, dest);
    const entries = await readdir(sftp, src);
    for (const entry of entries) {
      if (entry.attrs.isSymbolicLink()) continue;
      await copyRecursive(
        sftp,
        `${src}/${entry.filename}`,
        `${dest}/${entry.filename}`,
        entry.attrs,
      );
    }
  } else if (st.isFile()) {
    await writeBufferExclusive(sftp, dest, await readFile(sftp, src));
  }
}

async function uniqueDest(
  sftp: SFTPWrapper,
  remoteRoot: string,
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
    const resolved = resolveRemotePath(remoteRoot, candidate);
    if (!(await lstatOrNull(sftp, resolved.abs))) return resolved;
  }
  throw new Error('marudesk: too many copies');
}
