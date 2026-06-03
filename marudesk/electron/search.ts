import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  SearchFileResult,
  SearchMatch,
  SearchOptions,
  SearchResult,
} from '../shared/search';
import { isInsideRoot } from './fs-safe';
import { defineHandler, requireWorkspace } from './ipc/define-handler';
import { bool, obj, str } from './ipc/validate';
import { IGNORE_DIRS } from './workspace-config';

/**
 * Workspace content search. Prefers ripgrep (fast, respects .gitignore) and
 * falls back to a Node walk that reuses the workspace's IGNORE_DIRS and skips
 * binaries (NUL heuristic) + large files. Both run against the open workspace
 * root only; the query is passed as an argv element (never a shell), so even a
 * regex query can't inject a command.
 */

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 64 * 1024 * 1024;
const TIMEOUT = 20_000;
// Cap total matches so a query like "e" over a big tree can't flood the panel
// or blow the buffer; the UI shows "showing the first N" when hit.
const MAX_MATCHES = 1000;
const MAX_PER_FILE = 200;
const MAX_FILE_SIZE = 1024 * 1024; // 1MB — skip larger files in the Node walk
const MAX_PREVIEW = 400; // trim a very long matching line for the preview
// ripgrep caps per-file matches itself; keep it generous but bounded.
const RG_MAX_COUNT = 500;

/** Cached ripgrep availability — probed once per process. */
let rgAvailable: boolean | null = null;

async function hasRipgrep(): Promise<boolean> {
  if (rgAvailable !== null) return rgAvailable;
  try {
    await execFileAsync('rg', ['--version'], { timeout: 5_000 });
    rgAvailable = true;
  } catch {
    rgAvailable = false;
  }
  return rgAvailable;
}

/** One ripgrep --json "match" event (only the fields we read). */
type RgMatchEvent = {
  type: 'match';
  data: {
    path: { text?: string };
    lines: { text?: string };
    line_number: number;
    submatches: { start: number }[];
  };
};

function isRgMatch(v: unknown): v is RgMatchEvent {
  if (!v || typeof v !== 'object') return false;
  const e = v as { type?: unknown };
  return e.type === 'match';
}

async function searchRipgrep(
  root: string,
  query: string,
  opts: SearchOptions,
): Promise<SearchResult> {
  const args = [
    '--json',
    '--max-count',
    String(RG_MAX_COUNT),
    // Hidden files included, but the global IGNORE_DIRS still applied below via
    // glob excludes so behavior matches the explorer's file list.
    '--no-messages',
  ];
  if (!opts.caseSensitive) args.push('--ignore-case');
  if (opts.wholeWord) args.push('--word-regexp');
  if (!opts.regex) args.push('--fixed-strings');
  for (const dir of IGNORE_DIRS) args.push('--glob', `!**/${dir}/**`);
  // `--` terminates flags so a query starting with '-' isn't read as one.
  args.push('--', query, '.');

  let stdout: string;
  try {
    const res = await execFileAsync('rg', args, {
      cwd: root,
      maxBuffer: MAX_BUFFER,
      timeout: TIMEOUT,
    });
    stdout = res.stdout;
  } catch (err) {
    // ripgrep exits 1 when there are NO matches — that's a clean empty result,
    // not an error. Any other exit (2 = error, e.g. bad regex) re-throws.
    const e = err as { code?: number; stdout?: string; stderr?: string };
    if (e.code === 1) return { files: [], truncated: false, engine: 'ripgrep' };
    throw new Error((e.stderr || 'search failed').trim(), { cause: err });
  }

  const byFile = new Map<string, SearchMatch[]>();
  let total = 0;
  let truncated = false;
  for (const raw of stdout.split('\n')) {
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isRgMatch(parsed)) continue;
    const d = parsed.data;
    const rel = (d.path.text ?? '').replace(/\\/g, '/');
    if (!rel) continue;
    const lineText = (d.lines.text ?? '').replace(/\r?\n$/, '');
    const col = (d.submatches[0]?.start ?? 0) + 1; // bytes→1-based; good enough
    const arr = byFile.get(rel) ?? [];
    if (arr.length < MAX_PER_FILE) {
      arr.push({
        line: d.line_number,
        col,
        preview: lineText.slice(0, MAX_PREVIEW),
      });
      byFile.set(rel, arr);
    }
    total++;
    if (total >= MAX_MATCHES) {
      truncated = true;
      break;
    }
  }
  return { files: toSortedFiles(byFile), truncated, engine: 'ripgrep' };
}

/** Build a case-insensitive-aware matcher for the Node fallback. */
function makeMatcher(
  query: string,
  opts: SearchOptions,
): (line: string) => number {
  if (opts.regex || opts.wholeWord) {
    const body = opts.regex ? query : escapeRegExp(query);
    const pattern = opts.wholeWord ? `\\b(?:${body})\\b` : body;
    const flags = opts.caseSensitive ? 'g' : 'gi';
    const re = new RegExp(pattern, flags);
    return (line: string): number => {
      re.lastIndex = 0;
      const m = re.exec(line);
      return m ? m.index + 1 : 0;
    };
  }
  // Plain substring — cheaper than a regex per line.
  if (opts.caseSensitive) {
    return (line: string): number => {
      const i = line.indexOf(query);
      return i < 0 ? 0 : i + 1;
    };
  }
  const lower = query.toLowerCase();
  return (line: string): number => {
    const i = line.toLowerCase().indexOf(lower);
    return i < 0 ? 0 : i + 1;
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function searchNode(
  root: string,
  query: string,
  opts: SearchOptions,
): Promise<SearchResult> {
  const match = makeMatcher(query, opts);
  const byFile = new Map<string, SearchMatch[]>();
  let total = 0;
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
        if (IGNORE_DIRS.has(name) || name.startsWith('.')) continue;
        await walk(path.join(dir, name));
      } else if (entry.isFile()) {
        const full = path.join(dir, name);
        const st = await fs.stat(full).catch(() => null);
        if (!st || st.size > MAX_FILE_SIZE) continue;
        const buf = await fs.readFile(full).catch(() => null);
        if (!buf) continue;
        // Binary heuristic: a NUL byte in the first 8KB → skip (matches the
        // editor's read guard).
        if (buf.subarray(0, 8192).includes(0)) continue;
        const rel = path.relative(root, full).replace(/\\/g, '/');
        const lines = buf.toString('utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].replace(/\r$/, '');
          const col = match(line);
          if (col === 0) continue;
          const arr = byFile.get(rel) ?? [];
          if (arr.length < MAX_PER_FILE) {
            arr.push({ line: i + 1, col, preview: line.slice(0, MAX_PREVIEW) });
            byFile.set(rel, arr);
          }
          total++;
          if (total >= MAX_MATCHES) {
            truncated = true;
            return;
          }
        }
      }
    }
  }

  await walk(root);
  return { files: toSortedFiles(byFile), truncated, engine: 'node' };
}

function toSortedFiles(byFile: Map<string, SearchMatch[]>): SearchFileResult[] {
  const files: SearchFileResult[] = [];
  for (const [p, matches] of byFile) files.push({ path: p, matches });
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

async function searchContent(
  root: string,
  query: string,
  opts: SearchOptions,
): Promise<SearchResult> {
  if (query.length === 0) {
    return { files: [], truncated: false, engine: 'node' };
  }
  // A relative-path traversal can't happen — search is rooted at `root` and rg
  // is given '.' as its only path — but assert the walk stays inside as a belt.
  if (!isInsideRoot(root, root)) {
    throw new Error('invalid workspace root');
  }
  if (await hasRipgrep()) {
    // A ripgrep error other than "no matches" (e.g. a regex it rejects)
    // propagates so the renderer shows it rather than silently re-walking with
    // a different regex dialect that might match differently.
    return searchRipgrep(root, query, opts);
  }
  return searchNode(root, query, opts);
}

function parseOptions(value: unknown): SearchOptions {
  const o = obj(value, 'opts');
  return {
    caseSensitive:
      o.caseSensitive === undefined ? false : bool(o.caseSensitive, 'caseSensitive'),
    wholeWord: o.wholeWord === undefined ? false : bool(o.wholeWord, 'wholeWord'),
    regex: o.regex === undefined ? false : bool(o.regex, 'regex'),
  };
}

export function registerSearchHandlers(): void {
  defineHandler('search:content', ([payload]) => {
    const p = obj(payload);
    const query = str(p.query, 'query');
    const opts = parseOptions(p.opts);
    return searchContent(requireWorkspace().root, query, opts);
  });
}
