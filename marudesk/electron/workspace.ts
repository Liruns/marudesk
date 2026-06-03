import { dialog, type BrowserWindow } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  MAX_EDITOR_FILE_SIZE,
  type CaptureInput,
  type FileEntry,
  type RankedFile,
  type ReadFileResult,
  type SaveAsResult,
  type WorkspaceSummary,
  type WriteFileResult,
} from '../shared/workspace';
import {
  assertRealParentInsideRoot,
  atomicWriteFile,
  isInsideRoot,
  lstatOrNull,
  resolveWorkspacePath,
} from './fs-safe';
import { defineHandler, requireWorkspace } from './ipc/define-handler';
import { obj, str } from './ipc/validate';
import {
  COMMON_TAGS,
  CONTENT_CANDIDATES,
  IGNORE_DIRS,
  INDEXABLE_EXTENSIONS,
  MAX_FILE_SIZE,
  MAX_FILES,
  STOP_WORDS,
  TOP_RESULTS,
} from './workspace-config';

const execFileAsync = promisify(execFile);

// Editor reads/writes cap larger than the indexer's content scan: big enough
// for real source files, small enough to keep a file out of the editor (and
// out of a full-file overwrite on save) when it's clearly not source.
// The limit itself lives in shared/workspace.ts so the renderer's "too large"
// message can quote the same number.

let currentWorkspace: WorkspaceSummary | null = null;

export function getCurrentWorkspace(): WorkspaceSummary | null {
  return currentWorkspace;
}

async function openWorkspace(
  parentWindow: BrowserWindow,
): Promise<WorkspaceSummary | null> {
  const result = await dialog.showOpenDialog(parentWindow, {
    properties: ['openDirectory'],
    title: 'Open workspace',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return summarizeWorkspace(result.filePaths[0]);
}

async function summarizeWorkspace(root: string): Promise<WorkspaceSummary> {
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
        // skip unreadable
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

export async function readFileSafe(
  root: string,
  relPath: string,
  maxSize = MAX_FILE_SIZE,
): Promise<string> {
  // Route through the canonical resolver (rejects null bytes / ':' / traversal /
  // absolute paths) before touching disk — the editor read path already does,
  // and the ranking read must not be the weaker door. Then keep the symlink +
  // realpath guards for the actual read.
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

/**
 * Read a file for the editor. Unlike readFileSafe (which silently truncates for
 * ranking), this never returns partial content — a truncated buffer saved back
 * would destroy the file — so it refuses oversized or binary files outright and
 * reports why.
 */
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
  const buf = await fs.readFile(abs);
  // Binary heuristic: a NUL byte in the first 8 KB. Keeps images/binaries out
  // of a text editor that would corrupt them on save.
  if (buf.subarray(0, 8192).includes(0)) {
    return { ok: false, reason: 'binary' };
  }
  return { ok: true, content: buf.toString('utf8') };
}

/**
 * Overwrite an existing workspace file with edited text. Creation is out of
 * scope here (that path belongs to the explicit create handler), so a missing
 * file throws rather than being created via a save. Writes atomically via a
 * sibling temp file + rename.
 */
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
  // Atomic, symlink-safe overwrite (exclusive-create temp + rename) — see
  // fs-safe.atomicWriteFile. The destination was validated above.
  await atomicWriteFile(abs, content);
  return { ok: true };
}

/**
 * Save-As for an untitled editor buffer: prompt for a destination, then write
 * the content there. The destination MUST resolve inside the workspace — the
 * same sandbox invariant every other fs op honors — so a chosen path outside
 * the root is refused rather than written. Creates or overwrites; the write is
 * atomic (sibling temp + rename) and refuses a symlinked target/parent.
 */
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
  // Re-validate through the canonical resolver (rejects ':' / traversal / etc.).
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

export async function rankFiles(
  root: string,
  capture: CaptureInput,
  files: FileEntry[],
): Promise<RankedFile[]> {
  const keywords = extractKeywords(capture);
  if (keywords.length === 0) return [];

  const indexable = files.filter((f) =>
    INDEXABLE_EXTENSIONS.has(path.extname(f.path).toLowerCase()),
  );

  const pathScored = indexable.map((f) => {
    const { score, matches } = scorePath(f.path, keywords);
    return { entry: f, pathScore: score, matches };
  });

  pathScored.sort((a, b) => b.pathScore - a.pathScore);
  const candidates = pathScored.slice(0, CONTENT_CANDIDATES);

  const ranked: RankedFile[] = [];
  for (const c of candidates) {
    let contentScore = 0;
    const contentMatches: string[] = [];
    if (c.entry.size <= MAX_FILE_SIZE) {
      try {
        const content = await readFileSafe(root, c.entry.path);
        const lower = content.toLowerCase();
        for (const kw of keywords) {
          const lk = kw.toLowerCase();
          let count = 0;
          let from = 0;
          while (from < lower.length) {
            const i = lower.indexOf(lk, from);
            if (i < 0) break;
            count++;
            if (count >= 10) break;
            from = i + lk.length;
          }
          if (count > 0) {
            contentScore += Math.min(3 + (count - 1), 10);
            contentMatches.push(kw);
          }
        }
      } catch {
        // skip unreadable
      }
    }
    const total = c.pathScore + contentScore;
    if (total > 0) {
      ranked.push({
        path: c.entry.path,
        score: total,
        matches: Array.from(new Set([...c.matches, ...contentMatches])),
      });
    }
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, TOP_RESULTS);
}

function extractKeywords(capture: CaptureInput): string[] {
  const set = new Set<string>();

  if (capture.tagName) {
    const tag = capture.tagName.toLowerCase();
    if (tag.length >= 2 && !COMMON_TAGS.has(tag)) {
      set.add(tag);
    }
  }

  const attrs = capture.attributes ?? {};
  const id = attrs.id;
  if (id && id.length >= 2) set.add(id);

  const testId = attrs['data-testid'];
  if (testId && testId.length >= 2) set.add(testId);

  const role = attrs.role;
  if (role && role.length >= 3) set.add(role);

  const cls = attrs.class ?? '';
  for (const token of cls.split(/\s+/)) {
    if (token.length >= 3) set.add(token);
  }

  if (capture.text) {
    const tokens = capture.text
      .split(/[\s\W]+/)
      .filter((t) => t.length >= 3 && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(t))
      .map((t) => t.toLowerCase())
      .filter((t) => !STOP_WORDS.has(t));
    const seen = new Set<string>();
    let count = 0;
    for (const t of tokens) {
      if (seen.has(t)) continue;
      seen.add(t);
      set.add(t);
      count++;
      if (count >= 6) break;
    }
  }

  return Array.from(set);
}

function scorePath(
  filePath: string,
  keywords: string[],
): { score: number; matches: string[] } {
  const base = path.basename(filePath).toLowerCase();
  const dirParts = path
    .dirname(filePath)
    .toLowerCase()
    .split('/')
    .filter(Boolean);
  const matches: string[] = [];
  let score = 0;
  for (const kw of keywords) {
    const k = kw.toLowerCase();
    if (base.includes(k)) {
      score += 5;
      matches.push(kw);
      continue;
    }
    for (const dp of dirParts) {
      if (dp.includes(k)) {
        score += 2;
        matches.push(kw);
        break;
      }
    }
  }
  return { score, matches };
}

function isCaptureInput(value: unknown): value is CaptureInput {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.tagName !== undefined && typeof v.tagName !== 'string') return false;
  if (v.selector !== undefined && typeof v.selector !== 'string') return false;
  if (v.text !== undefined && typeof v.text !== 'string') return false;
  if (v.attributes !== undefined) {
    if (!v.attributes || typeof v.attributes !== 'object') return false;
    for (const [, val] of Object.entries(v.attributes)) {
      if (typeof val !== 'string') return false;
    }
  }
  return true;
}

export function registerWorkspaceHandlers(deps: {
  getMainWindow: () => BrowserWindow | null;
}): void {
  defineHandler('workspace:open', async () => {
    const win = deps.getMainWindow();
    if (!win) return null;
    const summary = await openWorkspace(win);
    if (summary) currentWorkspace = summary;
    return summary;
  });

  defineHandler('workspace:list', async ([root]) => {
    if (typeof root === 'string' && root.length > 0) {
      currentWorkspace = await summarizeWorkspace(root);
      return currentWorkspace;
    }
    return currentWorkspace;
  });

  defineHandler('workspace:rank', ([capture]) => {
    const { ws } = requireWorkspace();
    if (!isCaptureInput(capture)) throw new Error('invalid capture payload');
    return rankFiles(ws.root, capture, ws.files);
  });

  defineHandler('workspace:read-file', ([rel]) =>
    readFileForEditor(requireWorkspace().root, str(rel, 'path')),
  );

  defineHandler('workspace:write-file', ([payload]) => {
    const p = obj(payload);
    return writeFileForEditor(
      requireWorkspace().root,
      str(p.path, 'path'),
      str(p.content, 'content'),
    );
  });

  defineHandler('workspace:save-as', ([payload]) => {
    const content = str(obj(payload).content, 'content');
    const win = deps.getMainWindow();
    if (!win) return { ok: false };
    return saveAsForEditor(requireWorkspace().root, content, win);
  });
}
