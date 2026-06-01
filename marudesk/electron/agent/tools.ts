import path from 'node:path';
import type { WorkspaceSummary } from '../../shared/workspace';
import type { AppliedChange } from '../../shared/patch';
import { scrubText, scrubHeaders } from '../../shared/scrub';
import { urlToWorkspacePath } from '../../shared/runtime-evidence';
import type { NetworkRecord } from '../../shared/network-evidence';
import { readFileSafe } from '../workspace';
import { applyPatch } from '../patch';
import { getTab, getErrors, getNetwork, type TabRecord } from '../browser/state';
import { sendCdp, enableNetworkCapture } from '../browser/cdp';
import { getRecentTerminalOutput } from '../terminal';

/**
 * The agent tool layer (docs/agentic-chat-design.md §4) — the §9 promotion of
 * the assist-era capabilities into model-callable tools. Every executor delegates
 * to the SAME validated path the rest of the app uses (readFileSafe's symlink/
 * root guards, applyPatch's atomic 3-phase write, sendCdp's allowlist) — no new
 * fs/CDP permission surface. Every page-originated string that flows back to the
 * model is passed through shared/scrub.ts (P0.5).
 */

/* ── shapes ─────────────────────────────────────────────────────────────── */

export type ToolSchema = {
  name: string;
  description: string;
  /** JSON Schema for the tool input (Anthropic `input_schema`). */
  inputSchema: object;
};

export type ToolContext = {
  /**
   * The open workspace, or null when the user is chatting without a folder open.
   * File tools (read/list/grep/edit) are then unavailable and return a friendly
   * error; the browser/page tools (console/dom/network/eval) work regardless.
   */
  ws: WorkspaceSummary | null;
  /** The active web tab id — runtime tools (console/dom/network) target it. */
  tabId?: string;
  /** Aborts an in-flight tool (e.g. the wait inside reload_and_verify). */
  signal: AbortSignal;
  /**
   * Path globs the agent may never edit (Settings → Agent, Track B §B4). Checked
   * in applyEdits against each edit's workspace-relative path. Undefined/empty =
   * no extra deny rules (the read-side SECRET_FILE guard still applies).
   */
  denyGlobs?: string[];
};

export type ToolResult = {
  /** One-line card header, e.g. "edit src/App.tsx". */
  summary: string;
  /** tool_result content for the model — already scrubbed + clipped. */
  text: string;
  isError?: boolean;
  /** File edits applied by this call, for the chat's diff/revert history (P2). */
  edits?: AppliedChange[];
};

/**
 * Tools that require explicit user approval per call: code execution (eval_js)
 * and the sensitive read-only context tools (cookies / web storage often hold
 * session tokens). This is the interim of Track B §B4's `ask` default until the
 * full glob-permission / approval-mode system lands.
 */
export const GATED_TOOLS = new Set([
  'eval_js',
  'browser_cookies',
  'browser_storage',
  'terminal_output',
]);

/** `ask_user` is intercepted by the loop (it parks the turn), never executed here. */
export const ASK_USER = 'ask_user';

const MAX_TOOL_TEXT = 12_000;
const MAX_FILE_READ = 16_000;
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

const INDEXABLE = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.astro',
  '.html', '.htm', '.css', '.scss', '.sass', '.less', '.json', '.md',
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

async function readFile(input: { path?: unknown }, ctx: ToolContext): Promise<ToolResult> {
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
  const content = await readFileSafe(ctx.ws.root, p, MAX_FILE_READ);
  return { summary: `read ${p}`, text: clip(content) };
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
  input: { pattern?: unknown; glob?: unknown; maxResults?: unknown },
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!ctx.ws) return noWorkspaceResult('grep');
  const ws = ctx.ws; // capture so the narrowing survives into the async closure below
  const pattern = typeof input.pattern === 'string' ? input.pattern : '';
  if (!pattern) throw new Error('grep requires "pattern"');
  const needle = pattern.toLowerCase();
  const max = typeof input.maxResults === 'number' ? Math.min(input.maxResults, 200) : MAX_GREP_RESULTS;
  const re = typeof input.glob === 'string' && input.glob.trim() ? globToRegExp(input.glob.trim()) : null;

  const candidates = ws.files
    .filter((f) => INDEXABLE.has(path.extname(f.path).toLowerCase()))
    .filter((f) => (re ? re.test(f.path) : true))
    .slice(0, MAX_GREP_FILES);

  // Read in bounded-concurrency batches (file I/O is the bottleneck), but scan
  // results in file order and stop once `max` hits are collected — deterministic
  // output, parallel reads. A batch in flight when the cap is hit over-reads by
  // at most GREP_CONCURRENCY-1 files (acceptable, still bounded).
  const hits: string[] = [];
  let scanned = 0;
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
        if (lines[k].toLowerCase().includes(needle)) {
          hits.push(`${batch[j].path}:${k + 1}: ${lines[k].trim().slice(0, 200)}`);
          if (hits.length >= max) break batches;
        }
      }
    }
  }
  return {
    summary: `grep "${pattern}" → ${hits.length} hit${hits.length === 1 ? '' : 's'}`,
    text: hits.length ? clip(hits.join('\n')) : `no matches in ${scanned} files`,
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
  const res = await applyPatch(ctx.ws, ops);
  if (!res.ok) {
    const why = res.errors.map((e) => `${e.path}: ${e.reason}`).join('; ');
    return { summary: `${label} failed`, text: `edit failed — ${why}`, isError: true };
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

/* ── registry ───────────────────────────────────────────────────────────── */

export type Executor = (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;

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

async function terminalOutput(): Promise<ToolResult> {
  const res = getRecentTerminalOutput(8000);
  if (!res) return { summary: 'no terminal', text: 'No terminal session is open.' };
  if (!res.output.trim()) {
    return { summary: 'terminal (no output)', text: 'The most recent terminal has produced no output yet.' };
  }
  const note = res.count > 1 ? ` (most recent of ${res.count})` : '';
  return { summary: `terminal output${note}`, text: clip(scrubText(res.output)) };
}

const EXECUTORS: Record<string, Executor> = {
  read_file: readFile as Executor,
  list_files: listFiles as Executor,
  grep: grep as Executor,
  edit_file: editFile as Executor,
  multi_edit: multiEdit as Executor,
  get_console_errors: getConsoleErrors as Executor,
  query_dom: queryDom as Executor,
  eval_js: evalJs as Executor,
  read_network: readNetwork as Executor,
  read_network_body: readNetworkBody as Executor,
  reload_and_verify: reloadAndVerify as Executor,
  browser_cookies: browserCookies as Executor,
  browser_storage: browserStorage as Executor,
  terminal_output: terminalOutput as Executor,
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
  if (name === 'eval_js') return typeof o.expression === 'string' ? o.expression.slice(0, 500) : '(no expression)';
  return JSON.stringify(o).slice(0, 300);
}

const strProp = (desc: string) => ({ type: 'string', description: desc });

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: 'read_file',
    description: 'Read a UTF-8 workspace file (relative path). Use before editing so your oldString matches exactly.',
    inputSchema: { type: 'object', properties: { path: strProp('Workspace-relative path.') }, required: ['path'], additionalProperties: false },
  },
  {
    name: 'list_files',
    description: 'List indexed workspace files, optionally filtered by a glob (e.g. "src/**/*.tsx").',
    inputSchema: { type: 'object', properties: { glob: strProp('Optional glob; * and ** supported.') }, additionalProperties: false },
  },
  {
    name: 'grep',
    description: 'Case-insensitive literal substring search across indexed files. Returns path:line: text. Narrow with a glob.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: strProp('Literal substring to find.'),
        glob: strProp('Optional path glob to narrow the search.'),
        maxResults: { type: 'number', description: 'Cap on hits (default 60).' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit_file',
    description: 'Apply ONE string-replace edit. oldString must be a unique verbatim substring of the current file; set oldString="" to create a new file with newString as its contents. Atomic.',
    inputSchema: {
      type: 'object',
      properties: { path: strProp('Workspace-relative path.'), oldString: strProp('Unique substring to replace (or "" to create).'), newString: strProp('Replacement (or full contents for a new file).') },
      required: ['path', 'oldString', 'newString'],
      additionalProperties: false,
    },
  },
  {
    name: 'multi_edit',
    description: 'Apply several string-replace edits across one or more files atomically (all-or-nothing). Prefer this when a fix spans multiple sites.',
    inputSchema: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: { path: strProp('Workspace-relative path.'), oldString: strProp('Unique substring (or "" to create).'), newString: strProp('Replacement.') },
            required: ['path', 'oldString', 'newString'],
            additionalProperties: false,
          },
        },
      },
      required: ['edits'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_console_errors',
    description: 'Read the live page\'s captured runtime errors (always-on). Each carries a confidence-tagged source file when its stack maps deterministically to a workspace file. Start here for a "fix this error" task.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'Max errors (default 20).' } }, additionalProperties: false },
  },
  {
    name: 'query_dom',
    description: 'Inspect the live DOM: returns the matched element\'s outerHTML + key computed styles. Read-only.',
    inputSchema: { type: 'object', properties: { selector: strProp('CSS selector.') }, required: ['selector'], additionalProperties: false },
  },
  {
    name: 'eval_js',
    description: 'Evaluate a JavaScript expression in the live page and return the result. Powerful — requires user approval each call. Use for runtime probing you cannot get from query_dom/get_console_errors.',
    inputSchema: { type: 'object', properties: { expression: strProp('JS expression to evaluate.') }, required: ['expression'], additionalProperties: false },
  },
  {
    name: 'read_network',
    description: 'List recent network responses/failures captured from the live page (lazily enables capture). For TRIAGE: a failing status is often backend/infra, not a frontend bug. Secrets in URLs/headers are scrubbed.',
    inputSchema: { type: 'object', properties: { urlFilter: strProp('Optional substring to filter URLs.'), max: { type: 'number', description: 'Max rows (default 40).' } }, additionalProperties: false },
  },
  {
    name: 'read_network_body',
    description: 'Fetch a captured response body by requestId (from read_network). Secrets are scrubbed. Use to inspect a malformed response shape (e.g. "10%" where a number was expected).',
    inputSchema: { type: 'object', properties: { requestId: strProp('requestId from read_network.') }, required: ['requestId'], additionalProperties: false },
  },
  {
    name: 'reload_and_verify',
    description: 'Reload the page, wait for it to settle, then re-read the console. REQUIRED after editing to fix a runtime error — pass the error message as errorSignature to confirm it is GONE or STILL PRESENT. This closed loop is how you prove a fix worked.',
    inputSchema: {
      type: 'object',
      properties: { waitMs: { type: 'number', description: 'Settle wait, max 5000 (default 2500).' }, errorSignature: strProp('A substring of the error you expect to be gone.') },
      additionalProperties: false,
    },
  },
  {
    name: 'browser_cookies',
    description: "Read the live page's cookies (name, value, domain, flags). Read-only; values are secret-scrubbed. Requires user approval. Use to debug auth/session state.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'browser_storage',
    description: "Read the live page's localStorage and/or sessionStorage entries. Read-only; values are secret-scrubbed. Requires user approval.",
    inputSchema: { type: 'object', properties: { kind: strProp("'local', 'session', or omit for both.") }, additionalProperties: false },
  },
  {
    name: 'terminal_output',
    description: "Read the recent output (scrollback) of the most-recently-used integrated terminal. Read-only; ANSI-stripped and secret-scrubbed. Requires user approval. Use to see command results / build or test logs the user ran.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: ASK_USER,
    description: 'Ask the user one or more questions and wait for their answer. Use when the request is ambiguous or you need a decision before continuing.',
    inputSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: { question: strProp('The question.'), options: { type: 'array', items: { type: 'string' }, description: 'Optional suggested answers.' } },
            required: ['question'],
            additionalProperties: false,
          },
        },
      },
      required: ['questions'],
      additionalProperties: false,
    },
  },
];

/* ── MCP descriptor layer (docs/context-mcp-design §1.1) ─────────────────── */

/**
 * A tool's source group — used to organize the built-in "marudesk" context MCP
 * server and (later) to scope glob permissions. Browser/devtools/terminal/tabs
 * read the LIVE running app over CDP / main state; files reads the workspace;
 * sessions/memory read the new persistent stores; `ask` is the loop-intercepted
 * ask_user.
 */
export type McpGroup =
  | 'files'
  | 'browser'
  | 'devtools'
  | 'terminal'
  | 'tabs'
  | 'sessions'
  | 'memory'
  | 'ask';

/** A self-describing tool definition (JSON-Schema + the metadata the loop needs). */
export type McpToolDef = ToolSchema & {
  group: McpGroup;
  /** Requires explicit per-call user approval (e.g. eval_js, cookies/storage). */
  gated?: boolean;
  /** Mutates the workspace/app state — refused outright in read-only mode. */
  write?: boolean;
  /** Needs a live web tab as its target. */
  requiresWeb?: boolean;
  /** Needs an open workspace folder. */
  requiresWorkspace?: boolean;
};

/** A tool definition plus its in-process executor — what a built-in server holds. */
export type McpTool = McpToolDef & { exec: Executor };

const TOOL_GROUP: Record<string, McpGroup> = {
  read_file: 'files',
  list_files: 'files',
  grep: 'files',
  edit_file: 'files',
  multi_edit: 'files',
  get_console_errors: 'devtools',
  read_network: 'devtools',
  read_network_body: 'devtools',
  query_dom: 'browser',
  eval_js: 'browser',
  reload_and_verify: 'browser',
  browser_cookies: 'browser',
  browser_storage: 'browser',
  terminal_output: 'terminal',
};
const WRITE_TOOL_NAMES = new Set(['edit_file', 'multi_edit']);
const WEB_TOOL_NAMES = new Set([
  'get_console_errors',
  'query_dom',
  'eval_js',
  'read_network',
  'read_network_body',
  'reload_and_verify',
  'browser_cookies',
  'browser_storage',
]);
const WORKSPACE_TOOL_NAMES = new Set(['read_file', 'list_files', 'grep', 'edit_file', 'multi_edit']);

/**
 * The original file/runtime/context tools, expressed as MCP tools (schema +
 * executor + derived metadata). The single source of truth for gated/write/group
 * is the maps above + {@link GATED_TOOLS}; the loop reads these flags off the
 * descriptor instead of hard-coding tool-name sets.
 */
export const BUILTIN_TOOLS: McpTool[] = TOOL_SCHEMAS.flatMap((s) => {
  if (s.name === ASK_USER) return [];
  const exec = EXECUTORS[s.name];
  if (!exec) return [];
  return [
    {
      ...s,
      group: TOOL_GROUP[s.name] ?? 'files',
      gated: GATED_TOOLS.has(s.name),
      write: WRITE_TOOL_NAMES.has(s.name),
      requiresWeb: WEB_TOOL_NAMES.has(s.name),
      requiresWorkspace: WORKSPACE_TOOL_NAMES.has(s.name),
      exec,
    },
  ];
});

/** The ask_user definition (listed to the model; execution is loop-intercepted). */
export const ASK_USER_DEF: McpToolDef = {
  ...TOOL_SCHEMAS.find((s) => s.name === ASK_USER)!,
  group: 'ask',
};
