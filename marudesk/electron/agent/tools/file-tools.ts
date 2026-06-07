import path from 'node:path';
import { globToRegExp } from '../../../shared/glob';
import { SECRET_FILE_PATTERN as SECRET_FILE } from '../../../shared/secret-files';
import { clipText as clip } from '../../../shared/text-clip';
import { readFileSafe, readFileWindow } from '../../workspace';
import { resolveWorkspacePath } from '../../fs-safe';
import { applyPatch } from '../../patch';
import { isStaleForEdit, recordRead, updateAfterWrite } from '../read-tracker';
import { pageLines } from '../text-window';
import type { ToolContext, ToolResult } from './types';

/**
 * Workspace file tools (read_file / list_files / grep / edit_file / multi_edit).
 * Every executor delegates to the SAME validated path the rest of the app uses
 * (readFileSafe's symlink/root guards, applyPatch's atomic 3-phase write) — no
 * new fs permission surface — and refuses obvious credential files.
 */

const MAX_GREP_RESULTS = 60;
const MAX_GREP_FILES = 600;
const GREP_CONCURRENCY = 8;
// Per-line input bound + wall-clock budget for the regex path (ReDoS mitigation).
const MAX_GREP_LINE_LEN = 2_000;
const GREP_TIME_BUDGET_MS = 3_000;

// Skip obviously-binary files when grepping. Denylist (not an allowlist) so the
// search covers any text source — .py, .go, .rs, .yaml, .toml, .sh, … — instead
// of a fixed set of web/JS extensions.
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.bmp', '.tiff',
  '.pdf', '.zip', '.gz', '.tar', '.tgz', '.rar', '.7z', '.bz2', '.xz',
  '.mp3', '.mp4', '.mov', '.avi', '.mkv', '.wav', '.flac', '.ogg', '.webm',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.wasm', '.class', '.o', '.a',
]);

/** Uniform "file tools need an open folder" result for the no-workspace path. */
function noWorkspaceResult(tool: string): ToolResult {
  return {
    summary: `${tool} (no workspace)`,
    text: 'No folder is open, so file tools are unavailable. Ask the user to open a workspace (Explorer → Open Folder). Browser and page tools (console/DOM/network) work without one.',
    isError: true,
  };
}

export async function readFile(
  input: { path?: unknown; offset?: unknown; limit?: unknown },
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!ctx.ws) return noWorkspaceResult('read_file');
  const p = typeof input.path === 'string' ? input.path : '';
  if (!p) throw new Error('read_file requires "path"');
  if (SECRET_FILE.test(p)) {
    return {
      summary: `read ${p} (blocked)`,
      text: `Refused: "${p}" looks like a credentials file. Ask the user to share only the specific values you need.`,
      isError: true,
    };
  }
  // Read the whole file (up to the agent document limit) so the staleness anchor
  // covers content beyond the displayed window — then page the DISPLAY by line.
  const { content, truncated } = await readFileWindow(ctx.ws.root, p);
  // Binary content sniff (audit H10): the grep extension denylist can't catch a
  // binary file with a text-ish or absent extension. A NUL byte never appears in
  // real text, so refuse rather than spilling decoded mojibake into the context.
  if (content.includes('\u0000')) {
    return {
      summary: `read ${p} (binary)`,
      text: `Refused: "${p}" looks like a binary file (contains NUL bytes). read_file only handles text.`,
      isError: true,
    };
  }
  // Anchor the staleness guard to the full content we read, decoupled from the
  // window shown below: an edit anywhere in the file is then validated correctly.
  try {
    recordRead(resolveWorkspacePath(ctx.ws.root, p).abs, content);
  } catch {
    // A path that won't resolve can't be edited either — skip tracking.
  }

  const view = pageLines(content, { offset: input.offset, limit: input.limit, truncated });
  return {
    summary: `read ${p}${view.ranged ? ` (lines ${view.firstLine}-${view.lastLine})` : ''}`,
    text: view.text,
    touchedPaths: [p],
  };
}

export async function listFiles(input: { glob?: unknown }, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.ws) return noWorkspaceResult('list_files');
  const glob = typeof input.glob === 'string' && input.glob.trim() ? input.glob.trim() : '';
  const re = glob ? globToRegExp(glob) : null;
  const matched = ctx.ws.files
    .map((f) => f.path)
    .filter((p) => (re ? re.test(p) : true))
    .slice(0, 300);
  const more = ctx.ws.files.length > matched.length ? `\n…(${ctx.ws.files.length} total)` : '';
  return {
    summary: `list ${matched.length} file${matched.length === 1 ? '' : 's'}${glob ? ` (${glob})` : ''}`,
    text: matched.length ? matched.join('\n') + more : '(no files)',
  };
}

export async function grep(
  input: {
    pattern?: unknown;
    glob?: unknown;
    maxResults?: unknown;
    regex?: unknown;
    caseSensitive?: unknown;
  },
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!ctx.ws) return noWorkspaceResult('grep');
  const ws = ctx.ws; // capture so the narrowing survives into the async closure below
  const pattern = typeof input.pattern === 'string' ? input.pattern : '';
  if (!pattern) throw new Error('grep requires "pattern"');
  const caseSensitive = input.caseSensitive === true;
  const max =
    typeof input.maxResults === 'number'
      ? Math.max(1, Math.min(Math.floor(input.maxResults), 200))
      : MAX_GREP_RESULTS;
  const re = typeof input.glob === 'string' && input.glob.trim() ? globToRegExp(input.glob.trim()) : null;

  // Build the line matcher: a JS regex when regex=true, else a literal substring.
  let matches: (line: string) => boolean;
  if (input.regex === true) {
    let rx: RegExp;
    try {
      rx = new RegExp(pattern, caseSensitive ? '' : 'i');
    } catch (err) {
      return {
        summary: `grep (bad regex)`,
        text: `invalid regular expression: ${(err as Error).message}`,
        isError: true,
      };
    }
    // Bound the input each test sees (long minified lines are the usual trigger)
    // and cap total scan time below — JS RegExp can't be made fully ReDoS-proof
    // in-process, but the pattern comes from the in-process model and these two
    // bounds keep a slow pattern from wedging the whole scan.
    matches = (line) => rx.test(line.length > MAX_GREP_LINE_LEN ? line.slice(0, MAX_GREP_LINE_LEN) : line);
  } else if (caseSensitive) {
    matches = (line) => line.includes(pattern);
  } else {
    const needle = pattern.toLowerCase();
    matches = (line) => line.toLowerCase().includes(needle);
  }

  // Skip credential files: grep has no SECRET_FILE read guard of its own, and the
  // workspace index only filters IGNORE_DIRS, so without this a pattern could pull
  // .env / *.pem / id_rsa contents straight to the model.
  const filtered = ws.files
    .filter((f) => !BINARY_EXT.has(path.extname(f.path).toLowerCase()))
    .filter((f) => !SECRET_FILE.test(f.path))
    .filter((f) => (re ? re.test(f.path) : true));
  const moreFiles = filtered.length > MAX_GREP_FILES;
  const candidates = filtered.slice(0, MAX_GREP_FILES);

  // Read in bounded-concurrency batches (file I/O is the bottleneck), but scan
  // results in file order and stop once `max` hits are collected — deterministic
  // output, parallel reads. A batch in flight when the cap is hit over-reads by
  // at most GREP_CONCURRENCY-1 files (acceptable, still bounded).
  const hits: string[] = [];
  let scanned = 0;
  let capped = false;
  let timedOut = false;
  const deadline = Date.now() + GREP_TIME_BUDGET_MS;
  batches: for (let i = 0; i < candidates.length && hits.length < max; i += GREP_CONCURRENCY) {
    const batch = candidates.slice(i, i + GREP_CONCURRENCY);
    const contents = await Promise.all(
      batch.map((f) => readFileSafe(ws.root, f.path).catch(() => null)),
    );
    for (let j = 0; j < batch.length; j++) {
      const content = contents[j];
      if (content === null) continue;
      if (Date.now() > deadline) {
        timedOut = true;
        break batches;
      }
      scanned++;
      const lines = content.split('\n');
      for (let k = 0; k < lines.length; k++) {
        if (matches(lines[k])) {
          hits.push(`${batch[j].path}:${k + 1}: ${lines[k].trim().slice(0, 200)}`);
          if (hits.length >= max) {
            capped = true;
            break batches;
          }
        }
      }
    }
  }
  // Distinguish "found everything" from "hit a cap" so the model knows to narrow
  // with a glob or raise maxResults instead of trusting a partial result.
  const note = capped
    ? `\n…(stopped at ${max} hits — narrow with a glob or raise maxResults)`
    : timedOut
      ? `\n…(stopped after scanning ${scanned} files within the time budget — narrow with a glob)`
      : moreFiles
        ? `\n…(scanned the first ${MAX_GREP_FILES} matching files — narrow with a glob for the rest)`
        : '';
  return {
    summary: `grep "${pattern}" → ${hits.length} hit${hits.length === 1 ? '' : 's'}`,
    text: hits.length ? clip(hits.join('\n')) + note : `no matches in ${scanned} files`,
  };
}

function isOp(v: unknown): v is { path: string; oldString: string; newString: string } {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.path === 'string' &&
    o.path.length > 0 &&
    typeof o.oldString === 'string' &&
    typeof o.newString === 'string'
  );
}

async function applyEdits(
  ops: { path: string; oldString: string; newString: string }[],
  ctx: ToolContext,
  label: string,
): Promise<ToolResult> {
  if (!ctx.ws) return noWorkspaceResult(label);
  if (ctx.denyGlobs?.length) {
    const blocked = ops.find((op) =>
      ctx.denyGlobs!.some((g) => globToRegExp(g).test(op.path)),
    );
    if (blocked) {
      return {
        summary: `${label} blocked`,
        text: `Blocked: "${blocked.path}" matches a denied path glob (Settings → Agent). Edit it yourself if this is intended.`,
        isError: true,
      };
    }
  }
  // Staleness guard: refuse an edit to a file that changed on disk since the
  // agent read it (oh-my-openagent's hashline insight). Compare against the same
  // full-document view read_file anchors, so an edit anywhere in a large file is
  // validated correctly. Skip creates (oldString === '') and unresolvable/missing
  // paths — applyPatch emits the precise error for those.
  for (const op of ops) {
    if (op.oldString.length === 0) continue;
    let abs: string;
    try {
      abs = resolveWorkspacePath(ctx.ws.root, op.path).abs;
    } catch {
      continue;
    }
    let current: string;
    try {
      current = (await readFileWindow(ctx.ws.root, op.path)).content;
    } catch {
      continue;
    }
    if (isStaleForEdit(abs, current)) {
      // Self-heal (oh-my-openagent's mismatch UX): instead of just telling the
      // agent to re-read, hand back the CURRENT line-numbered content inline and
      // re-anchor the tracker to it — so the agent can redo the edit against the
      // fresh text in the same turn (the retry then passes this guard). The echo
      // is windowed (a large file can't be dumped) but the anchor is the full read.
      recordRead(abs, current);
      const view = pageLines(current);
      return {
        summary: `${label} blocked (stale)`,
        text: `"${op.path}" changed on disk since you last read it, so this edit was refused to avoid clobbering the newer content. Here is the file's CURRENT content (line-numbered, prefixes not part of the file) — redo your edit against it:\n\n${view.text}`,
        isError: true,
      };
    }
  }

  const res = await applyPatch(ctx.ws, ops);
  if (!res.ok) {
    const why = res.errors.map((e) => `${e.path}: ${e.reason}`).join('; ');
    return { summary: `${label} failed`, text: `edit failed — ${why}`, isError: true };
  }
  // Re-anchor each edited file to its freshly-written content so a follow-up edit
  // in the same turn validates against the new bytes, not the pre-edit read.
  for (const c of res.changes ?? []) {
    try {
      const abs = resolveWorkspacePath(ctx.ws.root, c.path).abs;
      updateAfterWrite(abs, (await readFileWindow(ctx.ws.root, c.path)).content);
    } catch {
      // Best-effort — failing to re-anchor only risks a spurious re-read prompt.
    }
  }
  const changedPaths = (res.changes ?? []).map((c) => c.path);
  const files = changedPaths.join(', ');
  return {
    summary: `${label}: ${files}`,
    text: `applied ${res.applied.length} edit${res.applied.length === 1 ? '' : 's'} to ${files}`,
    edits: res.changes,
    touchedPaths: changedPaths,
  };
}

export async function editFile(
  input: { path?: unknown; oldString?: unknown; newString?: unknown },
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!isOp(input)) {
    throw new Error('edit_file requires "path", "oldString", "newString" (oldString="" creates a new file)');
  }
  return applyEdits([{ path: input.path, oldString: input.oldString, newString: input.newString }], ctx, `edit ${input.path}`);
}

export async function multiEdit(input: { edits?: unknown }, ctx: ToolContext): Promise<ToolResult> {
  if (!Array.isArray(input.edits) || input.edits.length === 0 || !input.edits.every(isOp)) {
    throw new Error('multi_edit requires a non-empty "edits" array of {path, oldString, newString}');
  }
  return applyEdits(input.edits as { path: string; oldString: string; newString: string }[], ctx, `multi_edit ${input.edits.length} ops`);
}
