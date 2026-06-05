import path from 'node:path/posix';
import { randomBytes } from 'node:crypto';
import type { SFTPWrapper, Stats } from 'ssh2';
import { isSshRootKey } from '../../shared/ssh';

/**
 * Promisified SFTP primitives plus the remote analogue of fs-safe's path
 * contract. Every remote file op routes a renderer-supplied path through
 * {@link resolveRemotePath} (relative-only, no traversal past the root) and an
 * lstat/realpath guard so a symlink can never read or write outside the root —
 * the same invariants the local backend enforces, re-expressed for POSIX/SFTP.
 *
 * Unlike the local validator we do NOT reject ':' here: it's a legal character
 * in POSIX filenames and there is no Windows ADS/drive ambiguity on a remote
 * host. Absolute paths, null bytes, and traversal are still refused.
 */

/** SFTP status code for "no such file" (ssh2 surfaces it on the error's `code`). */
const SFTP_NO_SUCH_FILE = 2;

function isNoSuchFile(err: unknown): boolean {
  return (err as { code?: number } | null)?.code === SFTP_NO_SUCH_FILE;
}

export type RemoteRoot = { connectionId: string; remoteRoot: string };

/** Parse an `ssh://<connId><absPosixPath>` workspace-root key. */
export function parseRemoteRoot(rootKey: string): RemoteRoot {
  if (!isSshRootKey(rootKey)) {
    throw new Error(`marudesk: not a remote root: ${rootKey}`);
  }
  const rest = rootKey.slice('ssh://'.length);
  const slash = rest.indexOf('/');
  if (slash < 0) {
    throw new Error(`marudesk: malformed remote root: ${rootKey}`);
  }
  const connectionId = rest.slice(0, slash);
  const remoteRoot = rest.slice(slash);
  if (!connectionId) throw new Error(`marudesk: malformed remote root: ${rootKey}`);
  return { connectionId, remoteRoot };
}

/** True when `abs` is `root` itself or strictly contained within it (POSIX). */
export function isInsideRootPosix(root: string, abs: string): boolean {
  const r = path.resolve(root);
  const a = path.resolve(abs);
  return a === r || a.startsWith(r + '/');
}

/** Validate + resolve a workspace-relative POSIX path against a remote root. */
export function resolveRemotePath(
  remoteRoot: string,
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
  const normalized = rel.replace(/\\/g, '/').replace(/\/+/g, '/');
  const abs = path.resolve(remoteRoot, normalized);
  if (!isInsideRootPosix(remoteRoot, abs)) {
    throw new Error(`marudesk: path escapes workspace: ${rel}`);
  }
  return { rel: normalized, abs };
}

/** A single path segment: no separators, null byte, or '.'/'..'. */
export function assertValidRemoteName(name: string): string {
  if (name.length === 0) throw new Error('marudesk: name must not be empty');
  if (name.length > 255) throw new Error('marudesk: name is too long');
  if (/[/\0]/.test(name)) {
    throw new Error('marudesk: name must not contain / or null');
  }
  if (name === '.' || name === '..') throw new Error('marudesk: invalid name');
  return name;
}

/* ── promisified SFTP primitives ─────────────────────────────────────────── */

export function lstat(sftp: SFTPWrapper, p: string): Promise<Stats> {
  return new Promise((resolve, reject) => {
    sftp.lstat(p, (err, stats) => (err ? reject(err) : resolve(stats)));
  });
}

/** lstat that yields null instead of throwing when the path doesn't exist. */
export async function lstatOrNull(
  sftp: SFTPWrapper,
  p: string,
): Promise<Stats | null> {
  try {
    return await lstat(sftp, p);
  } catch (err) {
    if (isNoSuchFile(err)) return null;
    throw err;
  }
}

export function realpath(sftp: SFTPWrapper, p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    sftp.realpath(p, (err, abs) => (err ? reject(err) : resolve(abs)));
  });
}

export function readFile(sftp: SFTPWrapper, p: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.readFile(p, (err, buf) => (err ? reject(err) : resolve(buf)));
  });
}

export function mkdir(sftp: SFTPWrapper, p: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(p, (err) => (err ? reject(err) : resolve()));
  });
}

export function rmdir(sftp: SFTPWrapper, p: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rmdir(p, (err) => (err ? reject(err) : resolve()));
  });
}

export function unlink(sftp: SFTPWrapper, p: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.unlink(p, (err) => (err ? reject(err) : resolve()));
  });
}

export function rename(sftp: SFTPWrapper, src: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rename(src, dest, (err) => (err ? reject(err) : resolve()));
  });
}

export type RemoteDirEntry = { filename: string; attrs: Stats };

export function readdir(sftp: SFTPWrapper, dir: string): Promise<RemoteDirEntry[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(dir, (err, list) =>
      err
        ? reject(err)
        : resolve(list.map((e) => ({ filename: e.filename, attrs: e.attrs }))),
    );
  });
}

/** Create an empty file, failing if it already exists (exclusive 'wx'). */
export function createFileExclusive(sftp: SFTPWrapper, p: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.open(p, 'wx', (err, handle) => {
      if (err) {
        reject(err);
        return;
      }
      sftp.close(handle, (closeErr) =>
        closeErr ? reject(closeErr) : resolve(),
      );
    });
  });
}

/**
 * Write `content` to `abs` atomically: stream into an exclusive-create ('wx')
 * sibling temp with an unguessable name (so a pre-planted symlink at the temp
 * path can't redirect the write), then rename over the destination. Cleans up
 * the temp on failure. Path safety is the caller's responsibility.
 */
export async function writeFileAtomic(
  sftp: SFTPWrapper,
  abs: string,
  content: string,
): Promise<void> {
  const tmp = `${abs}.marudesk-tmp-${randomBytes(6).toString('hex')}`;
  await new Promise<void>((resolve, reject) => {
    const stream = sftp.createWriteStream(tmp, { flags: 'wx' });
    stream.on('error', reject);
    stream.on('close', () => resolve());
    stream.end(content, 'utf8');
  });
  try {
    await rename(sftp, tmp, abs);
  } catch (err) {
    await unlink(sftp, tmp).catch(() => undefined);
    throw err;
  }
}

/** Write raw bytes to a fresh path, failing if it already exists ('wx'). */
export function writeBufferExclusive(
  sftp: SFTPWrapper,
  p: string,
  data: Buffer,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = sftp.createWriteStream(p, { flags: 'wx' });
    stream.on('error', reject);
    stream.on('close', () => resolve());
    stream.end(data);
  });
}

/* ── shared guards (mirror fs-safe's assert* helpers) ────────────────────── */

/** For an existing path: refuse symlinks, confirm realpath stays inside root. */
export async function assertRealInsideRoot(
  sftp: SFTPWrapper,
  root: string,
  abs: string,
): Promise<void> {
  const st = await lstat(sftp, abs);
  if (st.isSymbolicLink()) {
    throw new Error('marudesk: refuses to follow symlink');
  }
  const real = await realpath(sftp, abs);
  if (!isInsideRootPosix(root, real)) {
    throw new Error('marudesk: path resolves outside workspace');
  }
}

/** For a not-yet-existing destination: confirm its parent's realpath is inside. */
export async function assertRealParentInsideRoot(
  sftp: SFTPWrapper,
  root: string,
  abs: string,
): Promise<void> {
  const real = await realpath(sftp, path.dirname(abs));
  if (!isInsideRootPosix(root, real)) {
    throw new Error('marudesk: destination resolves outside workspace');
  }
}

/** Run `tasks` with bounded concurrency, preserving input order in the result. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await task(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}
