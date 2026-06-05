import type { WorkspaceSummary } from '../../../shared/workspace';
import { scrubText, scrubHeaders } from '../../../shared/scrub';
import { clipText as clip } from '../../../shared/text-clip';
import { urlToWorkspacePath } from '../../../shared/runtime-evidence';
import type { NetworkRecord } from '../../../shared/network-evidence';
import { readFileSafe } from '../../workspace';
import { getErrors, getNetwork } from '../../browser/state';
import { sendCdp, enableNetworkCapture } from '../../browser/cdp';
import type { ToolContext, ToolResult } from './types';
import { requireTab, tabOrigin, evaluate } from './shared-helpers';

/**
 * Runtime observation tools backed by the live page (CDP): console errors,
 * DOM/JS inspection, network triage, page reload-and-verify, and the read-only
 * cookie/storage probes. Read-only except via the gated eval surface; every
 * page-originated string is scrubbed (P0.5) and bounded before it reaches the
 * model.
 */

const MAX_DOM_HTML = 4_000;
const RELOAD_WAIT_DEFAULT = 2_500;
const RELOAD_WAIT_MAX = 5_000;
// After the page reports it finished loading, give async errors a brief window
// to surface before reading the console (bounded so a turn can't stall).
const RELOAD_SETTLE = 800;
const MAX_BODY_BYTES = 256_000;

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

export async function getConsoleErrors(input: { limit?: unknown }, ctx: ToolContext): Promise<ToolResult> {
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

export async function queryDom(input: { selector?: unknown }, ctx: ToolContext): Promise<ToolResult> {
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

export async function evalJs(input: { expression?: unknown }, ctx: ToolContext): Promise<ToolResult> {
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

export async function readNetwork(
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

export async function readNetworkBody(input: { requestId?: unknown }, ctx: ToolContext): Promise<ToolResult> {
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

export async function reloadAndVerify(
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

export async function browserCookies(_input: unknown, ctx: ToolContext): Promise<ToolResult> {
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

export async function browserStorage(input: { kind?: unknown }, ctx: ToolContext): Promise<ToolResult> {
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
