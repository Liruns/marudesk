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
  const { files, source, truncated } = await listFiles(absRoot);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    root: absRoot,
    name: path.basename(absRoot),
    files,
    source,
    truncated,
  };
}

async function listFiles(root: string): Promise<{
  files: FileEntry[];
  source: 'git' | 'walk';
  truncated: boolean;
}> {
  const git = await listGitFiles(root);
  if (git) return git;
  return walkFiles(root);
}

async function listGitFiles(root: string): Promise<{
  files: FileEntry[];
  source: 'git';
  truncated: boolean;
} | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      [
        '-C',
        root,
        'ls-files',
        '-z',
        '--cached',
        '--others',
        '--exclude-standard',
      ],
      { maxBuffer: 64 * 1024 * 1024, timeout: 10_000 },
    );
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

async function walkFiles(root: string): Promise<{
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
        if (IGNORE_DIRS.has(name)) continue;
        if (name.startsWith('.')) continue;
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
