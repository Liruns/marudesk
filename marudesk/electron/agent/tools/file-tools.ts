import path from 'node:path';
import { clampNumber } from '../../../shared/coerce';
import { globToRegExp } from '../../../shared/glob';
import { SECRET_FILE_PATTERN as SECRET_FILE } from '../../../shared/secret-files';
import { clipText as clip } from '../../../shared/text-clip';
import { readFileSafe, readFileWindow } from '../../workspace';
import { resolveWorkspacePath } from '../../fs-safe';
import { applyPatch } from '../../patch';
import { isStaleForEdit, recordRead, snapshotLineContent, updateAfterWrite } from '../read-tracker';
import { pageLines } from '../text-window';
import {
  AnchorMismatchError,
  batchValidateAnchors,
  relocateAnchorByContent,
  resolveEditSpan,
  type ValidatedOp,
} from '../edit-span';
import { getDiagnosticsState } from '../../diagnostics/runner';
import type { Diagnostic } from '../../../shared/diagnostics';
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

  // Emit per-line hash anchors (v6 §W1 B-layer) so an edit can target a line by
  // its stable hash instead of copying it verbatim.
  const view = pageLines(content, { offset: input.offset, limit: input.limit, truncated, anchors: true });
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
  const all = ctx.ws.files
    .map((f) => f.path)
    .filter((p) => (re ? re.test(p) : true));
  const matched = all.slice(0, 300);
  // Footer counts MATCHES (not the whole index) so a glob-narrowed listing
  // doesn't read as truncated, and a truncated one says how to narrow.
  const more =
    all.length > matched.length
      ? `\n…(showing ${matched.length} of ${all.length} matches — narrow with a glob)`
      : '';
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
  const max = clampNumber(input.maxResults, MAX_GREP_RESULTS, 1, 200);
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

/** One edit op as the model supplies it — verbatim oldString and/or B-layer anchor. */
export type EditOp = {
  path: string;
  oldString: string;
  newString: string;
  anchor?: string;
  endAnchor?: string;
  anchorLine?: number;
  endAnchorLine?: number;
};

function isPosInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1;
}

function isOp(v: unknown): v is EditOp {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.path === 'string' &&
    o.path.length > 0 &&
    typeof o.oldString === 'string' &&
    typeof o.newString === 'string' &&
    (o.anchor === undefined || typeof o.anchor === 'string') &&
    (o.endAnchor === undefined || typeof o.endAnchor === 'string') &&
    (o.anchorLine === undefined || isPosInt(o.anchorLine)) &&
    (o.endAnchorLine === undefined || isPosInt(o.endAnchorLine))
  );
}

/** Cap how many post-edit diagnostic lines ride back on an edit result. */
const MAX_INLINE_DIAGNOSTICS = 20;

const DIAG_SEV_RANK: Record<Diagnostic['severity'], number> = { error: 0, warning: 1, info: 2 };

/**
 * After a successful write, surface the CACHED diagnostics that already cover the
 * just-edited files inline in the tool result, so the model sees a compile error it
 * just introduced in the SAME turn instead of needing a separate run_diagnostics
 * call. Reuses the shared diagnostics state ({@link getDiagnosticsState}) — the last
 * batch pass plus any live language-server findings — WITHOUT running the checker
 * (that path is gated/slow); so this is "errors known as of the last check", which
 * is exactly what a follow-up run_diagnostics would also have to refresh. Empty
 * string when there's nothing cached for the touched paths (the common clean case).
 */
function inlineDiagnostics(root: string | null, changedPaths: string[]): string {
  if (root === null || changedPaths.length === 0) return '';
  const state = getDiagnosticsState(root);
  const all = [...(state.lastRun?.diagnostics ?? []), ...state.live];
  if (all.length === 0) return '';
  const touched = new Set(changedPaths.map((p) => p.replace(/\\/g, '/')));
  const relevant = all
    .filter((d) => touched.has(d.file.replace(/\\/g, '/')))
    .sort((a, b) => DIAG_SEV_RANK[a.severity] - DIAG_SEV_RANK[b.severity] || a.line - b.line);
  if (relevant.length === 0) return '';

  const errors = relevant.filter((d) => d.severity === 'error').length;
  const warnings = relevant.filter((d) => d.severity === 'warning').length;
  const shown = relevant.slice(0, MAX_INLINE_DIAGNOSTICS);
  const lines = shown.map((d) => {
    const code = d.code ? ` ${d.code}` : '';
    return `  ${d.file}:${d.line}:${d.column} ${d.severity}${code} — ${d.message}`;
  });
  const more = relevant.length > shown.length ? `\n  …(${relevant.length - shown.length} more)` : '';
  return (
    `\n\nDiagnostics for the edited file(s) as of the last check (${errors} error(s), ${warnings} warning(s); ` +
    `run_diagnostics to refresh):\n${lines.join('\n')}${more}`
  );
}

/**
 * Zero-retry stale-anchor recovery (SECOND-PASS item 5). For every failing op in
 * `mismatch`, try to re-locate its stale anchor(s) by the exact line content the
 * model saw at read time (read-tracker snapshot) found uniquely in the current
 * file. On success, rewrite BOTH the validated copy and the original op (the one
 * applyPatch will run) to the fresh anchor + line, then re-validate the whole
 * batch. Returns true ONLY when the batch fully re-resolves after relocation —
 * any residual failure (a non-anchored vanished oldString, an ambiguous/absent
 * line) leaves the ops UNCHANGED and returns false, so the caller falls back to
 * the safe "re-read the file" self-heal. Conservative by construction: it can only
 * ever move an anchor onto a line whose content is identical + unique, never guess.
 */
function relocateStaleAnchors(
  mismatch: AnchorMismatchError,
  validated: ValidatedOp[],
  meta: { op: EditOp; abs: string; current: string }[],
): boolean {
  // Snapshot the current anchors so we can roll back atomically if the batch still
  // doesn't resolve — a partial relocate must never leak into the applied edit.
  const backups = meta.map((m) => ({
    anchor: m.op.anchor,
    anchorLine: m.op.anchorLine,
    endAnchor: m.op.endAnchor,
    endAnchorLine: m.op.endAnchorLine,
  }));

  let relocatedAny = false;
  for (const failure of mismatch.failures) {
    const v = validated[failure.opIndex];
    const m = meta[failure.opIndex];
    if (!v || !m) return false; // index drift — bail to the safe path
    // Only ANCHORED ops with a known read-view line can be relocated by content.
    if (!m.op.anchor || m.op.anchorLine === undefined) return false;
    const startLine = snapshotLineContent(m.abs, m.op.anchorLine);
    const startReloc = relocateAnchorByContent(m.current, startLine);
    if (!startReloc.ok) return false;
    m.op.anchor = startReloc.anchor;
    m.op.anchorLine = startReloc.line;
    v.op.anchor = startReloc.anchor;
    v.op.anchorLine = startReloc.line;
    // Relocate the endAnchor too when the op spans a range.
    if (m.op.endAnchor !== undefined && m.op.endAnchorLine !== undefined) {
      const endLine = snapshotLineContent(m.abs, m.op.endAnchorLine);
      const endReloc = relocateAnchorByContent(m.current, endLine);
      if (!endReloc.ok) return false;
      m.op.endAnchor = endReloc.anchor;
      m.op.endAnchorLine = endReloc.line;
      v.op.endAnchor = endReloc.anchor;
      v.op.endAnchorLine = endReloc.line;
    }
    relocatedAny = true;
  }
  if (!relocatedAny) return false;

  // Re-validate: every op (including any that weren't in `failures`) must now
  // resolve against its current content, or we roll back and fall through.
  for (const v of validated) {
    if (v.op.oldString.length === 0 && !v.op.anchor) continue;
    if (!resolveEditSpan(v.current, v.op).ok) {
      restoreAnchors(meta, backups);
      return false;
    }
  }
  return true;
}

/** Roll back anchor mutations on a failed relocate (keeps the original edit ops intact). */
function restoreAnchors(
  meta: { op: EditOp }[],
  backups: { anchor?: string; anchorLine?: number; endAnchor?: string; endAnchorLine?: number }[],
): void {
  for (let i = 0; i < meta.length; i++) {
    const b = backups[i];
    if (!b) continue;
    meta[i].op.anchor = b.anchor;
    meta[i].op.anchorLine = b.anchorLine;
    meta[i].op.endAnchor = b.endAnchor;
    meta[i].op.endAnchorLine = b.endAnchorLine;
  }
}

/** Pick only the patch-op fields from a validated edit op (drops any extras). */
function toPatchOp(op: EditOp): EditOp {
  return {
    path: op.path,
    oldString: op.oldString,
    newString: op.newString,
    ...(op.anchor ? { anchor: op.anchor } : {}),
    ...(op.endAnchor ? { endAnchor: op.endAnchor } : {}),
    ...(op.anchorLine !== undefined ? { anchorLine: op.anchorLine } : {}),
    ...(op.endAnchorLine !== undefined ? { endAnchorLine: op.endAnchorLine } : {}),
  };
}

/**
 * Apply a batch of edit ops through the full write gate — SECRET_FILE refusal,
 * denyGlobs, staleness/anchor validation, then the atomic 3-phase patch — and
 * return a ToolResult (with `edits` for revert history). Exported so other tools
 * that synthesize multi-file edits (e.g. the LSP rename tool, LSP-1) route their
 * writes through the SAME guards instead of a raw fs write. file-tools does not
 * import those callers, so the export introduces no import cycle.
 */
export async function applyEdits(
  ops: EditOp[],
  ctx: ToolContext,
  label: string,
): Promise<ToolResult> {
  if (!ctx.ws) return noWorkspaceResult(label);
  // Never let the agent WRITE a credentials/secret file. The read path already
  // refuses these (SECRET_FILE is correctly anchored with (^|/)), but denyGlobs —
  // the only other write gate — can miss root-level secrets (a leading `**/`
  // requires a literal '/'), so guard writes with the same anchored pattern.
  const secret = ops.find((op) => SECRET_FILE.test(op.path));
  if (secret) {
    return {
      summary: `${label} blocked`,
      text: `Blocked: "${secret.path}" looks like a credentials/secret file and cannot be written by the agent.`,
      isError: true,
    };
  }
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
  // Staleness + anchor-resolution guard: refuse edits to a file that changed on
  // disk since the agent read it (oh-my-openagent's hashline insight) OR whose
  // anchored/verbatim target no longer resolves. Unlike the old fail-on-first
  // behaviour, this validates ALL ops up front and reports EVERY failing op at
  // once, so a multi_edit can be re-anchored in a SINGLE retry. Compare against
  // the same full-document view read_file anchors. Skip creates (oldString === ''
  // and no anchor) — they have nothing to clobber.
  const validated: ValidatedOp[] = [];
  // Parallel to `validated`: the ORIGINAL op + its abs path, so the zero-retry
  // relocate (item 5) can look up the per-read line snapshot for a failing op and
  // rewrite its anchor on the original op that applyPatch will run.
  const validatedMeta: { op: EditOp; abs: string; current: string }[] = [];
  const staleEntries: { op: EditOp; abs: string; current: string }[] = [];
  for (const op of ops) {
    // Creates (no oldString and no anchor) have nothing to clobber — skip them.
    if (op.oldString.length === 0 && !op.anchor) continue;
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
    validated.push({ op: toPatchOp(op), current });
    validatedMeta.push({ op, abs, current });
    if (isStaleForEdit(abs, current)) staleEntries.push({ op, abs, current });
  }

  // Two sources of trouble: a file that changed on disk (stale hash) and an op
  // that no longer resolves. Collect both into ONE batch of failures + remaps.
  let mismatch: AnchorMismatchError | null = null;
  try {
    batchValidateAnchors(validated);
  } catch (err) {
    if (err instanceof AnchorMismatchError) mismatch = err;
    else throw err;
  }

  // Zero-retry stale-anchor recovery (SECOND-PASS item 5): before bouncing back to
  // the model for a re-read, try to re-locate each failing ANCHORED op by the exact
  // line content the model saw at read time (read-tracker snapshot). The relocate
  // is conservative — it only succeeds on an EXACT, UNIQUE whole-line match (see
  // relocateAnchorByContent), so it can never land on the wrong line. We only take
  // the recovery when EVERY validated op then re-resolves cleanly; otherwise we
  // leave `ops`/`mismatch` untouched and fall through to the normal self-heal.
  if (mismatch && relocateStaleAnchors(mismatch, validated, validatedMeta)) {
    mismatch = null;
    // Re-anchor the trackers for any file that only tripped the hash check but is
    // now fully resolvable, so the relocated ops apply below without a stale block.
    staleEntries.length = 0;
  }

  if (staleEntries.length > 0 || mismatch) {
    // Self-heal (oh-my-openagent's mismatch UX): instead of just telling the agent
    // to re-read, hand back the CURRENT line-numbered content for every affected
    // file inline (with fresh per-line anchors) and re-anchor the tracker to it,
    // so the agent can redo EVERY failing edit against fresh text in the same turn.
    // Re-anchor each stale file's tracker to its current bytes (the retry then
    // passes this guard for files that only tripped the hash check).
    for (const s of staleEntries) recordRead(s.abs, s.current);

    // De-dup affected files (a multi_edit may touch one file several times) while
    // keeping the current content we already read for each.
    const affected = new Map<string, string>();
    for (const s of staleEntries) affected.set(s.op.path, s.current);
    for (const f of mismatch?.failures ?? []) {
      const v = validated.find((e) => e.op.path === f.path);
      if (v && !affected.has(f.path)) affected.set(f.path, v.current);
    }

    // Per-op failure lines (path + reason). Stale-but-resolvable files get a
    // staleness reason so every affected target is named.
    const reasons: string[] = [];
    const named = new Set<string>();
    for (const f of mismatch?.failures ?? []) {
      reasons.push(`${f.path}: ${f.reason}`);
      named.add(f.path);
    }
    for (const s of staleEntries) {
      if (!named.has(s.op.path)) {
        reasons.push(`${s.op.path}: changed on disk since you last read it`);
        named.add(s.op.path);
      }
    }

    const blocks: string[] = [];
    for (const [p, current] of affected) {
      blocks.push(`── ${p} ──\n${pageLines(current, { anchors: true }).text}`);
    }
    return {
      summary: `${label} blocked (${reasons.length} failing op${reasons.length === 1 ? '' : 's'})`,
      text:
        `${reasons.length} edit${reasons.length === 1 ? '' : 's'} were refused — the file(s) changed since you read them, so applying would clobber newer content or target the wrong line.\n\n` +
        `Failing edits:\n${reasons.map((r) => `  - ${r}`).join('\n')}\n\n` +
        `Here is the CURRENT content of each affected file (line-numbered with per-line anchors; the "N <hash>" prefix before the tab is not part of the file) — redo every failing edit against it:\n\n` +
        blocks.join('\n\n'),
      isError: true,
    };
  }

  const res = await applyPatch(ctx.ws, ops.map(toPatchOp));
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
  // Append the touched files' cached diagnostics so a just-introduced compile error
  // is visible in THIS turn rather than after a separate run_diagnostics call.
  const diagnostics = inlineDiagnostics(ctx.ws.root, changedPaths);
  return {
    summary: `${label}: ${files}`,
    text: `applied ${res.applied.length} edit${res.applied.length === 1 ? '' : 's'} to ${files}${diagnostics}`,
    edits: res.changes,
    touchedPaths: changedPaths,
  };
}

export async function editFile(
  input: { path?: unknown; oldString?: unknown; newString?: unknown; anchor?: unknown; endAnchor?: unknown },
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!isOp(input)) {
    throw new Error('edit_file requires "path", "oldString", "newString" (oldString="" creates a new file; or pass an "anchor" line hash)');
  }
  return applyEdits([toPatchOp(input)], ctx, `edit ${input.path}`);
}

export async function multiEdit(input: { edits?: unknown }, ctx: ToolContext): Promise<ToolResult> {
  if (!Array.isArray(input.edits) || input.edits.length === 0 || !input.edits.every(isOp)) {
    throw new Error('multi_edit requires a non-empty "edits" array of {path, oldString, newString}');
  }
  return applyEdits(input.edits.map(toPatchOp), ctx, `multi_edit ${input.edits.length} ops`);
}
