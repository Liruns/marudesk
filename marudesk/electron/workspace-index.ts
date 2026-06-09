import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FileEntry, WorkspaceSummary } from '../shared/workspace';
import { isSshRootKey } from '../shared/ssh';
import { isInsideRoot } from './fs-safe';
import { sshSummarize } from './ssh/ssh-workspace';
import { IGNORE_DIRS, MAX_FILES } from './workspace-config';

const execFileAsync = promisify(execFile);

export async function summarizeWorkspace(root: string): Promise<WorkspaceSummary> {
  if (isSshRootKey(root)) return sshSummarize(root);
  const absRoot = path.resolve(root);
  const { files, source, truncated } = await listFiles(absRoot, false);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    root: absRoot,
    name: path.basename(absRoot),
    files,
    source,
    truncated,
  };
}

/**
 * The flat file list for a root, optionally INCLUDING git-ignored (and dotfile)
 * entries. Used by the Explorer's "show ignored files" toggle — a read-only,
 * on-demand call that does NOT touch the cached workspace summary, so search /
 * mentions keep their curated (ignored-excluded) view.
 */
export async function listWorkspaceFiles(
  root: string,
  includeIgnored: boolean,
): Promise<FileEntry[]> {
  if (isSshRootKey(root)) return [];
  const absRoot = path.resolve(root);
  const { files } = await listFiles(absRoot, includeIgnored);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

async function listFiles(
  root: string,
  includeIgnored: boolean,
): Promise<{
  files: FileEntry[];
  source: 'git' | 'walk';
  truncated: boolean;
}> {
  const git = await listGitFiles(root, includeIgnored);
  if (git) return git;
  return walkFiles(root, includeIgnored);
}

async function listGitFiles(
  root: string,
  includeIgnored: boolean,
): Promise<{
  files: FileEntry[];
  source: 'git';
  truncated: boolean;
} | null> {
  try {
    // `--exclude-standard` filters out .gitignore'd (and excluded) files. Dropping
    // it while keeping `--others` surfaces ignored untracked files too — exactly
    // the "show ignored" view. `.git` itself is never listed by ls-files.
    const args = ['-C', root, 'ls-files', '-z', '--cached', '--others'];
    if (!includeIgnored) args.push('--exclude-standard');
    const { stdout } = await execFileAsync('git', args, {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 10_000,
    });
    const rel = stdout.split('\0').filter(Boolean);
    if (rel.length === 0) return null;
    const truncated = rel.length > MAX_FILES;
    const sliced = truncated ? rel.slice(0, MAX_FILES) : rel;
    const files: FileEntry[] = [];
    for (const r of sliced) {
      try {
        const abs = path.resolve(root, r);
        if (!isInsideRoot(root, abs)) continue;
        const st = await fs.lstat(abs);
        if (!st.isFile()) continue;
        files.push({ path: r.replace(/\\/g, '/'), size: st.size });
      } catch {
        // Skip unreadable git entries.
      }
    }
    return { files, source: 'git', truncated };
  } catch {
    return null;
  }
}

async function walkFiles(
  root: string,
  includeIgnored: boolean,
): Promise<{
  files: FileEntry[];
  source: 'walk';
  truncated: boolean;
}> {
  const files: FileEntry[] = [];
  let truncated = false;

  async function walk(dir: string): Promise<void> {
    if (truncated) return;
    const entries = await fs
      .readdir(dir, { withFileTypes: true })
      .catch(() => null);
    if (!entries) return;
    for (const entry of entries) {
      if (truncated) return;
      const name = entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        // `.git` is always skipped (huge + never useful). With "show ignored" on,
        // dotfolders and the usual ignore set ARE walked so they become visible;
        // otherwise they're skipped as before.
        if (name === '.git') continue;
        if (!includeIgnored && IGNORE_DIRS.has(name)) continue;
        if (!includeIgnored && name.startsWith('.')) continue;
        await walk(path.join(dir, name));
      } else if (entry.isFile()) {
        const full = path.join(dir, name);
        const rel = path.relative(root, full).replace(/\\/g, '/');
        const st = await fs.stat(full).catch(() => null);
        if (!st) continue;
        files.push({ path: rel, size: st.size });
        if (files.length >= MAX_FILES) {
          truncated = true;
          return;
        }
      }
    }
  }

  await walk(root);
  return { files, source: 'walk', truncated };
}
