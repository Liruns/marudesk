import path from 'node:path';
import type { WorkspaceSummary } from '../../../shared/workspace';
import { scrubText, scrubHeaders } from '../../../shared/scrub';
import { urlToWorkspacePath } from '../../../shared/runtime-evidence';
import type { NetworkRecord } from '../../../shared/network-evidence';
import { readFileSafe, readFileWindow } from '../../workspace';
import { resolveWorkspacePath } from '../../fs-safe';
import { applyPatch } from '../../patch';
import { isStaleForEdit, recordRead, updateAfterWrite } from '../read-tracker';
import { getTab, getErrors, getNetwork, type TabRecord } from '../../browser/state';
import { sendCdp, enableNetworkCapture } from '../../browser/cdp';
import type { Executor, ToolContext, ToolResult } from './types';

/**
 * The agent tool executors (docs/agentic-chat-design.md §4) — the §9 promotion of
 * the assist-era capabilities into model-callable tools. Every executor delegates
 * to the SAME validated path the rest of the app uses (readFileSafe's symlink/
 * root guards, applyPatch's atomic 3-phase write, sendCdp's allowlist) — no new
 * fs/CDP permission surface. Every page-originated string that flows back to the
 * model is passed through shared/scrub.ts (P0.5).
 */

const MAX_TOOL_TEXT = 12_000;
// read_file pages by line: default lines per call, hard byte budget per call,
// and a per-line clip so one pathological line can't blow the budget.
const MAX_READ_LINES = 1_500;
const MAX_READ_LINE_LEN = 2_000;
const MAX_GREP_RESULTS = 60;
const MAX_GREP_FILES = 600;
const GREP_CONCURRENCY = 8;
const MAX_DOM_HTML = 4_000;
const RELOAD_WAIT_DEFAULT = 2_500;
const RELOAD_WAIT_MAX = 5_000;
// After the page reports it finished loading, give async errors a brief window
// to surface before reading the console (bounded so a turn can't stall).
const RELOAD_SETTLE = 800;
const MAX_BODY_BYTES = 256_000;

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

// Defense-in-depth: refuse to hand obvious credential files to the model. These
// are inside the workspace (the fs sandbox already blocks escape) but reading a
// `.env` / private key wholesale would leak secrets that scrub can't fully catch
// in arbitrary formats. The user can still paste what they truly need.
const SECRET_FILE =
  /(^|\/)(\.env(\.[\w-]+)?|\.npmrc|\.netrc|\.pgpass|id_(?:rsa|dsa|ecdsa|ed25519)|.*\.pem|.*\.key|.*\.p12|.*\.pfx|credentials(\.json)?)$/i;

function clip(s: string, max = MAX_TOOL_TEXT): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…[clipped ${s.length - max} chars]`;
}

/**
 * Prefix each line with a right-aligned 1-based number + tab (cat -n style), so
 * the model can anchor edits and reason about locations. The numbers are display
 * only — `oldString` for an edit must still be the verbatim file text WITHOUT
 * these prefixes (the read_file/edit_file descriptions say so).
 */
/** Coerce a tool input into a positive integer, falling back when absent/invalid. */
function toPosInt(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : fallback;
}

/** Clip a single line so one pathological (e.g. minified) line can't dominate. */
function clipLine(line: string): string {
  return line.length <= MAX_READ_LINE_LEN
    ? line
    : `${line.slice(0, MAX_READ_LINE_LEN)}… [line truncated, ${line.length} chars]`;
}

/**
 * Render lines `start..last` (1-based, inclusive) from `lines` with right-aligned
 * `N\t` prefixes (display only — NOT part of the file), stopping early if the
 * byte budget would be exceeded. Returns the text plus the last line actually
 * shown so the caller can offer a continuation offset.
 */
function renderWindow(
  lines: string[],
  start: number,
  end: number,
  budget = MAX_TOOL_TEXT,
): { text: string; lastShown: number } {
  const width = String(end).length;
  const parts: string[] = [];
  let used = 0;
  let lastShown = start - 1;
  for (let i = start; i <= end; i++) {
    const rendered = `${String(i).padStart(width, ' ')}\t${clipLine(lines[i - 1])}`;
    if (i > start && used + rendered.length + 1 > budget) break;
    parts.push(rendered);
    used += rendered.length + 1;
    lastShown = i;
  }
  return { text: parts.join('\n'), lastShown };
}

function requireTab(ctx: ToolContext): TabRecord {
  if (!ctx.tabId) {
    throw new Error('no active web tab — open a web page so runtime tools have a target');
  }
  const rec = getTab(ctx.tabId);
  if (!rec || rec.kind !== 'web' || !rec.view) {
    throw new Error('the active tab is not a live web page');
  }
  return rec;
}

function tabOrigin(rec: TabRecord): string {
  try {
    return new URL(rec.view!.webContents.getURL()).origin;
  } catch {
    return '';
  }
}

/** Convert a `*`/`**` glob to an anchored regex (linear-time). Empty → match-all. */
function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = esc.replace(/\*\*|\*/g, (m) => (m === '**' ? '.*' : '[^/]*'));
  return new RegExp(`^${body}$`, 'i');
}

/* ── CDP helpers ────────────────────────────────────────────────────────── */

type EvalOutcome = { ok: true; value: unknown } | { ok: false; error: string };

async function evaluate(rec: TabRecord, expression: string): Promise<EvalOutcome> {
  const res = (await sendCdp(rec, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    timeout: 5_000,
  })) as {
    result?: { value?: unknown; description?: string };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  if (res?.exceptionDetails) {
    const ex = res.exceptionDetails;
    return { ok: false, error: ex.exception?.description || ex.text || 'evaluation threw' };
  }
  return { ok: true, value: res?.result?.value ?? res?.result?.description };
}

/* ── file tools ─────────────────────────────────────────────────────────── */

/** Uniform "file tools need an open folder" result for the no-workspace path. */
function noWorkspaceResult(tool: string): ToolResult {
  return {
    summary: `${tool} (no workspace)`,
    text: 'No folder is open, so file tools are unavailable. Ask the user to open a workspace (Explorer → Open Folder). Browser and page tools (console/DOM/network) work without one.',
    isError: true,
  };
}

async function readFile(
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
  // Anchor the staleness guard to the full content we read, decoupled from the
  // window shown below: an edit anywhere in the file is then validated correctly.
  try {
    recordRead(resolveWorkspacePath(ctx.ws.root, p).abs, content);
  } catch {
    // A path that won't resolve can't be edited either — skip tracking.
  }

  if (content.length === 0 && !truncated) {
    return { summary: `read ${p} (empty)`, text: '(empty file)' };
  }

  const lines = content.split('\n');
  const total = lines.length;
  const start = Math.min(toPosInt(input.offset, 1), total);
  const limit = Math.min(toPosInt(input.limit, MAX_READ_LINES), MAX_READ_LINES);
  const end = Math.min(start + limit - 1, total);
  const { text, lastShown } = renderWindow(lines, start, end);

  let footer = '';
  if (lastShown < total) {
    footer = `\n…(showing lines ${start}-${lastShown} of ${truncated ? `${total}+` : total} — read with offset=${lastShown + 1} for more)`;
  } else if (truncated) {
    footer = `\n…(file exceeds the agent read limit; lines past ${total} are not shown)`;
  }
  const ranged = start > 1 || lastShown < total;
  return {
    summary: `read ${p}${ranged ? ` (lines ${start}-${lastShown})` : ''}`,
    text: text + footer,
  };
}

async function listFiles(input: { glob?: unknown }, ctx: ToolContext): Promise<ToolResult> {
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

async function grep(
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
  const max = typeof input.maxResults === 'number' ? Math.min(input.maxResults, 200) : MAX_GREP_RESULTS;
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
    matches = (line) => rx.test(line);
  } else if (caseSensitive) {
    matches = (line) => line.includes(pattern);
  } else {
    const needle = pattern.toLowerCase();
    matches = (line) => line.toLowerCase().includes(needle);
  }

  const candidates = ws.files
    .filter((f) => !BINARY_EXT.has(path.extname(f.path).toLowerCase()))
    .filter((f) => (re ? re.test(f.path) : true))
    .slice(0, MAX_GREP_FILES);

  // Read in bounded-concurrency batches (file I/O is the bottleneck), but scan
  // results in file order and stop once `max` hits are collected — deterministic
  // output, parallel reads. A batch in flight when the cap is hit over-reads by
  // at most GREP_CONCURRENCY-1 files (acceptable, still bounded).
  const hits: string[] = [];
  let scanned = 0;
  let capped = false;
  batches: for (let i = 0; i < candidates.length && hits.length < max; i += GREP_CONCURRENCY) {
    const batch = candidates.slice(i, i + GREP_CONCURRENCY);
    const contents = await Promise.all(
      batch.map((f) => readFileSafe(ws.root, f.path).catch(() => null)),
    );
    for (let j = 0; j < batch.length; j++) {
      const content = contents[j];
      if (content === null) continue;
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
  // Distinguish "found everything" from "hit the result/file caps" so the model
  // knows to narrow with a glob or raise maxResults instead of trusting a partial.
  const note = capped
    ? `\n…(stopped at ${max} hits — narrow with a glob or raise maxResults)`
    : candidates.length >= MAX_GREP_FILES
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
      const lines = current.split('\n');
      const end = Math.min(lines.length, MAX_READ_LINES);
      const { text, lastShown } = renderWindow(lines, 1, end);
      const more = lastShown < lines.length ? `\n…(showing lines 1-${lastShown} of ${lines.length} — read_file with offset for the rest)` : '';
      return {
        summary: `${label} blocked (stale)`,
        text: `"${op.path}" changed on disk since you last read it, so this edit was refused to avoid clobbering the newer content. Here is the file's CURRENT content (line-numbered, prefixes not part of the file) — redo your edit against it:\n\n${text}${more}`,
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
  const files = (res.changes ?? []).map((c) => c.path).join(', ');
  return {
    summary: `${label}: ${files}`,
    text: `applied ${res.applied.length} edit${res.applied.length === 1 ? '' : 's'} to ${files}`,
    edits: res.changes,
  };
}

async function editFile(
  input: { path?: unknown; oldString?: unknown; newString?: unknown },
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!isOp(input)) {
    throw new Error('edit_file requires "path", "oldString", "newString" (oldString="" creates a new file)');
  }
  return applyEdits([{ path: input.path, oldString: input.oldString, newString: input.newString }], ctx, `edit ${input.path}`);
}

async function multiEdit(input: { edits?: unknown }, ctx: ToolContext): Promise<ToolResult> {
  if (!Array.isArray(input.edits) || input.edits.length === 0 || !input.edits.every(isOp)) {
    throw new Error('multi_edit requires a non-empty "edits" array of {path, oldString, newString}');
  }
  return applyEdits(input.edits as { path: string; oldString: string; newString: string }[], ctx, `multi_edit ${input.edits.length} ops`);
}

/* ── runtime tools (CDP) ────────────────────────────────────────────────── */

async function resolveErrorFile(
  ws: WorkspaceSummary | null,
  origin: string,
  urls: string[],
): Promise<string | null> {
  if (!ws) return null; // no workspace → can't map a stack frame to a source file
  for (const u of urls) {
    const rel = u ? urlToWorkspacePath(u, origin) : null;
    if (!rel) continue;
    try {
      await readFileSafe(ws.root, rel, 1);
      return rel;
    } catch {
      // not a readable workspace file — try the next frame
    }
  }
  return null;
}

async function getConsoleErrors(input: { limit?: unknown }, ctx: ToolContext): Promise<ToolResult> {
  const rec = requireTab(ctx);
  const origin = tabOrigin(rec);
  const limit = typeof input.limit === 'number' ? Math.min(input.limit, 50) : 20;
  const errors = getErrors(ctx.tabId!).slice(-limit);
  if (errors.length === 0) {
    return { summary: 'no console errors', text: 'The page has no captured runtime errors.' };
  }
  const blocks: string[] = [];
  for (const ev of errors) {
    const urls = [...ev.stack.map((f) => f.url)];
    if (ev.source?.url) urls.push(ev.source.url);
    const file = await resolveErrorFile(ctx.ws, origin, urls);
    // P1: deterministic stack→file resolution = high confidence; otherwise the
    // error is real but we can't point at a source file with certainty.
    const confidence = file ? 'high' : 'low';
    const lines = [`[${ev.origin}] ${scrubText(ev.message)}`];
    if (file) lines.push(`  source: ${file} (confidence: ${confidence})`);
    else lines.push(`  source: (unresolved — bundled/cross-origin; confidence: ${confidence})`);
    if (ev.stack.length > 0) {
      const top = ev.stack.slice(0, 4).map((f) => `    at ${f.functionName || '(anon)'} ${f.url}:${f.lineNumber + 1}`);
      lines.push(...top);
    }
    blocks.push(lines.join('\n'));
  }
  return {
    summary: `${errors.length} console error${errors.length === 1 ? '' : 's'}`,
    text: clip(blocks.join('\n\n')),
  };
}

async function queryDom(input: { selector?: unknown }, ctx: ToolContext): Promise<ToolResult> {
  const rec = requireTab(ctx);
  const selector = typeof input.selector === 'string' ? input.selector : '';
  if (!selector) throw new Error('query_dom requires "selector"');
  // Fixed, injection-safe expression: the selector is JSON-encoded data, not
  // code. Read-only — returns outerHTML + a few computed styles for the match.
  const expr = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const cs = getComputedStyle(el);
    const props = ['display','position','width','height','color','background-color','font-size','margin','padding','flex','grid-template-columns'];
    const style = {}; for (const p of props) style[p] = cs.getPropertyValue(p);
    return { outerHTML: el.outerHTML.slice(0, ${MAX_DOM_HTML}), style };
  })()`;
  const out = await evaluate(rec, expr);
  if (!out.ok) return { summary: `query_dom ${selector}`, text: `query failed — ${scrubText(out.error)}`, isError: true };
  if (out.value == null) return { summary: `query_dom ${selector}`, text: `no element matches ${selector}` };
  const v = out.value as { outerHTML?: string; style?: Record<string, string> };
  const styleText = v.style ? Object.entries(v.style).filter(([, x]) => x).map(([k, x]) => `${k}: ${x}`).join('; ') : '';
  return {
    summary: `query_dom ${selector}`,
    text: clip(scrubText(`outerHTML:\n${v.outerHTML ?? ''}\n\ncomputed style: ${styleText}`)),
  };
}

async function evalJs(input: { expression?: unknown }, ctx: ToolContext): Promise<ToolResult> {
  const rec = requireTab(ctx);
  const expression = typeof input.expression === 'string' ? input.expression : '';
  if (!expression) throw new Error('eval_js requires "expression"');
  const out = await evaluate(rec, expression);
  if (!out.ok) return { summary: 'eval_js (threw)', text: `threw — ${scrubText(out.error)}`, isError: true };
  const text = typeof out.value === 'string' ? out.value : JSON.stringify(out.value, null, 2);
  return { summary: 'eval_js', text: clip(scrubText(text ?? 'undefined')) };
}

/* ── interaction tools (CDP, write) ─────────────────────────────────────────
 * The "agent drives the running app" wedge. Each builds a fixed, injection-safe
 * JS expression (the selector/value/key are JSON-encoded *data*, never spliced
 * as code) and runs it through the SAME Runtime.evaluate path as eval_js — so
 * the CDP allowlist is unchanged (no Input. domain) and the attack surface is
 * identical. All four are gated + write (read-only mode refuses them; ask mode
 * approves per call), and every returned string is scrubbed + clipped. */

async function click(input: { selector?: unknown }, ctx: ToolContext): Promise<ToolResult> {
  const rec = requireTab(ctx);
  const selector = typeof input.selector === 'string' ? input.selector : '';
  if (!selector) throw new Error('click requires "selector"');
  const expr = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false };
    el.scrollIntoView({ block: 'center' });
    el.click();
    return { ok: true };
  })()`;
  const out = await evaluate(rec, expr);
  if (!out.ok) return { summary: `click ${selector}`, text: `click failed — ${scrubText(out.error)}`, isError: true };
  const v = (out.value ?? {}) as { ok?: boolean };
  if (!v.ok) return { summary: `click ${selector}`, text: `no element matches ${selector}`, isError: true };
  return { summary: `clicked "${selector}"`, text: clip(scrubText(`clicked ${selector}`)) };
}

async function fill(
  input: { selector?: unknown; value?: unknown },
  ctx: ToolContext,
): Promise<ToolResult> {
  const rec = requireTab(ctx);
  const selector = typeof input.selector === 'string' ? input.selector : '';
  if (!selector) throw new Error('fill requires "selector"');
  const value = typeof input.value === 'string' ? input.value : '';
  // React (and other controlled inputs) ignore a plain `el.value =` because they
  // track value via the prototype setter; call the NATIVE setter then dispatch
  // input+change so the framework's onChange fires. contenteditable uses
  // textContent + an input event.
  const expr = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false };
    const value = ${JSON.stringify(value)};
    el.focus();
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      const proto = tag === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.isContentEditable) {
      el.textContent = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      return { ok: false, unfillable: true };
    }
    return { ok: true };
  })()`;
  const out = await evaluate(rec, expr);
  if (!out.ok) return { summary: `fill ${selector}`, text: `fill failed — ${scrubText(out.error)}`, isError: true };
  const v = (out.value ?? {}) as { ok?: boolean; unfillable?: boolean };
  if (!v.ok) {
    const why = v.unfillable
      ? `${selector} is not an input/textarea/contenteditable`
      : `no element matches ${selector}`;
    return { summary: `fill ${selector}`, text: why, isError: true };
  }
  return { summary: `filled "${selector}"`, text: clip(scrubText(`filled ${selector}`)) };
}

async function pressKey(
  input: { key?: unknown; selector?: unknown },
  ctx: ToolContext,
): Promise<ToolResult> {
  const rec = requireTab(ctx);
  const key = typeof input.key === 'string' ? input.key : '';
  if (!key) throw new Error('press_key requires "key" (e.g. "Enter", "Escape", "Tab", "ArrowDown")');
  const selector = typeof input.selector === 'string' ? input.selector : '';
  // Dispatch a synthetic keydown+keyup on the target (selector element, focused
  // first) or the active element. Good enough for standard key handlers
  // (Enter/Escape/Tab/arrows); not a full trusted-event key press.
  const expr = `(() => {
    const sel = ${JSON.stringify(selector)};
    let el = sel ? document.querySelector(sel) : document.activeElement;
    if (sel) {
      if (!el) return { ok: false };
      el.focus();
    }
    el = el || document.body;
    const key = ${JSON.stringify(key)};
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
    return { ok: true };
  })()`;
  const out = await evaluate(rec, expr);
  if (!out.ok) return { summary: `press_key ${key}`, text: `press_key failed — ${scrubText(out.error)}`, isError: true };
  const v = (out.value ?? {}) as { ok?: boolean };
  if (!v.ok) return { summary: `press_key ${key}`, text: `no element matches ${selector}`, isError: true };
  const where = selector ? ` on "${selector}"` : '';
  return { summary: `pressed ${key}${where}`, text: clip(scrubText(`pressed ${key}${where}`)) };
}

async function scroll(
  input: { selector?: unknown; direction?: unknown },
  ctx: ToolContext,
): Promise<ToolResult> {
  const rec = requireTab(ctx);
  const selector = typeof input.selector === 'string' ? input.selector : '';
  const direction = input.direction === 'up' ? 'up' : 'down';
  // Selector → smooth-scroll it into view; otherwise scroll the window a screenful.
  const expr = selector
    ? `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { ok: false };
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return { ok: true };
      })()`
    : `(() => {
        window.scrollBy(0, ${direction === 'up' ? -600 : 600});
        return { ok: true };
      })()`;
  const out = await evaluate(rec, expr);
  if (!out.ok) return { summary: 'scroll', text: `scroll failed — ${scrubText(out.error)}`, isError: true };
  const v = (out.value ?? {}) as { ok?: boolean };
  if (!v.ok) return { summary: `scroll ${selector}`, text: `no element matches ${selector}`, isError: true };
  const what = selector ? `scrolled "${selector}" into view` : `scrolled ${direction}`;
  return { summary: what, text: clip(scrubText(what)) };
}

function formatNetwork(records: NetworkRecord[]): string {
  return records
    .map((r) => {
      const status = r.failed ? `FAILED (${r.errorText ?? 'unknown'})` : `${r.status ?? '?'} ${r.statusText ?? ''}`.trim();
      const head = `${status}  ${r.resourceType ?? ''}  ${scrubText(r.url) || '(url n/a)'}`;
      const hdrs = r.responseHeaders ? scrubHeaders(r.responseHeaders) : {};
      const ct = hdrs['content-type'] ?? hdrs['Content-Type'];
      return `- [${r.requestId}] ${head}${ct ? `  content-type: ${ct}` : ''}`;
    })
    .join('\n');
}

async function readNetwork(
  input: { urlFilter?: unknown; max?: unknown },
  ctx: ToolContext,
): Promise<ToolResult> {
  const rec = requireTab(ctx);
  const live = await enableNetworkCapture(rec);
  const filter = typeof input.urlFilter === 'string' ? input.urlFilter.toLowerCase() : '';
  const max = typeof input.max === 'number' ? Math.min(input.max, 80) : 40;
  let records = getNetwork(ctx.tabId!);
  if (filter) records = records.filter((r) => r.url.toLowerCase().includes(filter));
  records = records.slice(-max);
  const note = live
    ? records.length === 0
      ? 'Network capture is on but nothing has been recorded yet — reload the page (reload_and_verify) to populate it.'
      : 'Triage: a failing status (4xx/5xx/CORS) is often caused by the backend/infra, not the frontend. Use read_network_body to inspect a response shape.'
    : 'Could not enable network capture (built-in DevTools may hold the CDP client).';
  return {
    summary: `read_network → ${records.length} request${records.length === 1 ? '' : 's'}`,
    text: clip(`${note}\n\n${formatNetwork(records)}`),
  };
}

async function readNetworkBody(input: { requestId?: unknown }, ctx: ToolContext): Promise<ToolResult> {
  const rec = requireTab(ctx);
  const requestId = typeof input.requestId === 'string' ? input.requestId : '';
  if (!requestId) throw new Error('read_network_body requires "requestId" (from read_network)');
  const res = (await sendCdp(rec, 'Network.getResponseBody', { requestId })) as {
    body?: string;
    base64Encoded?: boolean;
  };
  if (res?.base64Encoded) {
    return { summary: `body ${requestId}`, text: '(binary/base64 body omitted)' };
  }
  // Bound before scrubbing so a multi-MB body doesn't get fully regex-scanned.
  const raw = res?.body ?? '(empty)';
  const bounded = raw.length > MAX_BODY_BYTES ? raw.slice(0, MAX_BODY_BYTES) : raw;
  return { summary: `body ${requestId}`, text: clip(scrubText(bounded)) };
}

async function reloadAndVerify(
  input: { waitMs?: unknown; errorSignature?: unknown },
  ctx: ToolContext,
): Promise<ToolResult> {
  const rec = requireTab(ctx);
  const waitMs = Math.min(typeof input.waitMs === 'number' ? input.waitMs : RELOAD_WAIT_DEFAULT, RELOAD_WAIT_MAX);
  const signature = typeof input.errorSignature === 'string' ? input.errorSignature : '';
  // Reload via the app navigation path (Page.navigate is allowlist-blocked). The
  // did-navigate handler clears the error buffer, so what we read after the wait
  // is purely the NEW document's errors. Wait for the load to actually finish
  // (ceiling = waitMs) rather than a blind sleep that could read the OLD doc's
  // errors on a slow navigation, then a short settle for async errors to surface.
  const wc = rec.view!.webContents;
  wc.reload();
  await new Promise<void>((resolve, reject) => {
    let settle: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const cleanup = () => {
      clearTimeout(ceiling);
      if (settle) clearTimeout(settle);
      wc.off('did-stop-loading', onStop);
      ctx.signal.removeEventListener('abort', onAbort);
    };
    const finishWait = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve();
    };
    const onAbort = () => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error('aborted'));
    };
    const onStop = () => {
      clearTimeout(ceiling);
      settle = setTimeout(finishWait, Math.min(RELOAD_SETTLE, waitMs));
    };
    const ceiling = setTimeout(finishWait, waitMs);
    wc.once('did-stop-loading', onStop);
    ctx.signal.addEventListener('abort', onAbort, { once: true });
  });
  const after = getErrors(ctx.tabId!);
  const matched = signature ? after.filter((e) => e.message.includes(signature)) : [];
  const verdict = signature
    ? matched.length > 0
      ? `STILL PRESENT — ${matched.length} error(s) still match "${signature}".`
      : `GONE — no error matches "${signature}" after reload.`
    : after.length === 0
      ? 'No console errors after reload.'
      : `${after.length} console error(s) after reload.`;
  const sample = after.slice(0, 6).map((e) => `- [${e.origin}] ${scrubText(e.message)}`).join('\n');
  return {
    summary: `reloaded; ${after.length} error${after.length === 1 ? '' : 's'} after`,
    text: clip(`${verdict}${sample ? `\n\n${sample}` : ''}`),
  };
}

/* ── context tools (Track B §B1 — on-demand, read-only, secret-scrubbed) ──── */

async function browserCookies(_input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const rec = requireTab(ctx);
  const res = (await sendCdp(rec, 'Network.getCookies')) as {
    cookies?: Array<{
      name: string;
      value: string;
      domain: string;
      path: string;
      httpOnly?: boolean;
      secure?: boolean;
      expires?: number;
    }>;
  };
  const cookies = res?.cookies ?? [];
  if (cookies.length === 0) {
    return { summary: 'no cookies', text: 'The page has no cookies.' };
  }
  const lines = cookies.map((c) => {
    const flags = [c.httpOnly ? 'httpOnly' : '', c.secure ? 'secure' : '']
      .filter(Boolean)
      .join(' ');
    return `${c.name}=${c.value}  [${c.domain}${c.path}${flags ? ` ${flags}` : ''}]`;
  });
  return {
    summary: `${cookies.length} cookie${cookies.length === 1 ? '' : 's'}`,
    text: clip(scrubText(lines.join('\n'))),
  };
}

async function browserStorage(input: { kind?: unknown }, ctx: ToolContext): Promise<ToolResult> {
  const rec = requireTab(ctx);
  const origin = tabOrigin(rec);
  if (!origin) {
    return { summary: 'storage', text: 'The page has no origin — cannot read web storage.', isError: true };
  }
  // DOMStorage commands need the domain enabled first (idempotent; shared safely
  // with the Application panel — both read the one debugger's stream).
  await sendCdp(rec, 'DOMStorage.enable').catch(() => {});
  const want = input.kind === 'session' ? 'session' : input.kind === 'local' ? 'local' : 'both';
  const read = async (isLocalStorage: boolean): Promise<string[]> => {
    const res = (await sendCdp(rec, 'DOMStorage.getDOMStorageItems', {
      storageId: { securityOrigin: origin, isLocalStorage },
    })) as { entries?: [string, string][] };
    return (res?.entries ?? []).map(([k, v]) => `${k}=${v}`);
  };
  const blocks: string[] = [];
  if (want === 'local' || want === 'both') {
    const items = await read(true).catch(() => []);
    blocks.push(`localStorage (${items.length}):\n${items.join('\n') || '(empty)'}`);
  }
  if (want === 'session' || want === 'both') {
    const items = await read(false).catch(() => []);
    blocks.push(`sessionStorage (${items.length}):\n${items.join('\n') || '(empty)'}`);
  }
  return { summary: `storage @ ${origin}`, text: clip(scrubText(blocks.join('\n\n'))) };
}

/* ── registry ───────────────────────────────────────────────────────────── */

export const EXECUTORS: Record<string, Executor> = {
  read_file: readFile as Executor,
  list_files: listFiles as Executor,
  grep: grep as Executor,
  edit_file: editFile as Executor,
  multi_edit: multiEdit as Executor,
  get_console_errors: getConsoleErrors as Executor,
  query_dom: queryDom as Executor,
  eval_js: evalJs as Executor,
  click: click as Executor,
  fill: fill as Executor,
  press_key: pressKey as Executor,
  scroll: scroll as Executor,
  read_network: readNetwork as Executor,
  read_network_body: readNetworkBody as Executor,
  reload_and_verify: reloadAndVerify as Executor,
  browser_cookies: browserCookies as Executor,
  browser_storage: browserStorage as Executor,
};

export async function executeTool(
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const exec = EXECUTORS[name];
  if (!exec) return { summary: `unknown tool ${name}`, text: `no such tool: ${name}`, isError: true };
  try {
    return await exec((input ?? {}) as Record<string, unknown>, ctx);
  } catch (err) {
    return { summary: `${name} error`, text: `${name} failed — ${scrubText((err as Error).message)}`, isError: true };
  }
}

/** A short, safe preview of a gated tool's input for the approval card. */
export function describeToolInput(name: string, input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>;
  if (name === 'generate_image') return typeof o.prompt === 'string' ? o.prompt.slice(0, 500) : '(no prompt)';
  if (name === 'generate_video') return typeof o.prompt === 'string' ? o.prompt.slice(0, 500) : '(no prompt)';
  if (name === 'eval_js') return typeof o.expression === 'string' ? o.expression.slice(0, 500) : '(no expression)';
  // Interaction tools (click/fill/press_key/scroll): show the action target plainly.
  if (name === 'click') return typeof o.selector === 'string' ? `click ${o.selector}`.slice(0, 300) : '(no selector)';
  if (name === 'fill') {
    const sel = typeof o.selector === 'string' ? o.selector : '?';
    const val = typeof o.value === 'string' ? o.value : '';
    return `fill ${sel} = ${val}`.slice(0, 300);
  }
  if (name === 'press_key') {
    const key = typeof o.key === 'string' ? o.key : '?';
    const sel = typeof o.selector === 'string' ? ` on ${o.selector}` : '';
    return `press ${key}${sel}`.slice(0, 300);
  }
  if (name === 'scroll') {
    if (typeof o.selector === 'string') return `scroll to ${o.selector}`.slice(0, 300);
    return `scroll ${o.direction === 'up' ? 'up' : 'down'}`;
  }
  // PC-control / path tools: show the target plainly — this is an approval card.
  if (typeof o.path === 'string') return o.path.slice(0, 300);
  if (typeof o.url === 'string') return o.url.slice(0, 300);
  return JSON.stringify(o).slice(0, 300);
}
