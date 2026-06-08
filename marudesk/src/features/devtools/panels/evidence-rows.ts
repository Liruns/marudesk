import type { AgentMessage, ToolCall } from '../../../../shared/agent';
import type { ConsoleEntry, NetworkEntry } from '../types';

/**
 * Pure row-builders for the runtime evidence timeline (EvidenceTimeline.tsx),
 * kept in their own module so they're unit-testable and don't trip
 * react-refresh's "components-only export" rule. Three sources merge onto one
 * wall-clock axis: console problems, network problems, and the agent's page
 * actions (read straight from the chat transcript's tool calls — §3.3/§3.5).
 */

// The agent tools that ACT on / read the live page (mirrors the "browser" +
// "runtime" tool groups in electron/agent/tools/registry.ts). File/system tools
// are intentionally excluded — this is a page-action log.
const PAGE_ACTION_TOOLS = new Set([
  'query_dom',
  'eval_js',
  'click',
  'fill',
  'press_key',
  'scroll',
  'reload_and_verify',
]);

export type RowSource = 'console' | 'network' | 'agent';

export type Row = {
  id: string;
  /** console id / network requestId / tool-call id — used to run the row's action. */
  refId: string;
  source: RowSource;
  /** Wall-clock ms for ordering; 0 when a network row predates wallTime capture. */
  t: number;
  variant: 'error' | 'warning' | 'accent';
  label: string;
  summary: string;
  /** Whether the row offers a fix/triage action (warnings + agent actions can't). */
  actionable: boolean;
};

function consoleSummary(e: ConsoleEntry): string {
  if (e.text && e.text.trim()) return e.text.trim();
  const parts = e.args
    .map((a) => a.description ?? (a.value !== undefined ? String(a.value) : ''))
    .filter(Boolean);
  if (parts.length > 0) return parts.join(' ');
  return e.kind;
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search || u.host;
  } catch {
    return url;
  }
}

function truncate(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** A concise target for a page-action row: the tool's own summary, else its args. */
function actionSummary(call: ToolCall): string {
  if (call.summary && call.summary.trim()) return call.summary.trim();
  const inp = (call.input && typeof call.input === 'object' ? call.input : {}) as Record<string, unknown>;
  const sel = typeof inp.selector === 'string' ? inp.selector : '';
  switch (call.name) {
    case 'fill':
      return `${sel} = ${truncate(String(inp.value ?? ''), 40)}`.trim();
    case 'press_key':
      return [String(inp.key ?? ''), sel].filter(Boolean).join(' · ');
    case 'scroll':
      return [String(inp.direction ?? ''), sel].filter(Boolean).join(' · ');
    case 'eval_js':
      return truncate(String(inp.expression ?? ''), 60);
    case 'reload_and_verify':
      return typeof inp.errorSignature === 'string' && inp.errorSignature
        ? `verify: ${inp.errorSignature}`
        : 'reload & verify';
    default:
      return sel || call.name;
  }
}

export function buildProblemRows(entries: ConsoleEntry[], network: NetworkEntry[]): Row[] {
  const rows: Row[] = [];
  for (const e of entries) {
    if (e.kind !== 'error' && e.kind !== 'exception' && e.kind !== 'warning') continue;
    rows.push({
      id: `c:${e.id}`,
      refId: e.id,
      source: 'console',
      t: e.timestamp,
      variant: e.kind === 'warning' ? 'warning' : 'error',
      label: e.kind === 'exception' ? 'exception' : e.kind,
      summary: consoleSummary(e),
      actionable: e.kind === 'error' || e.kind === 'exception',
    });
  }
  for (const n of network) {
    const is4xx5xx = typeof n.status === 'number' && n.status >= 400;
    if (!n.failed && !is4xx5xx) continue;
    rows.push({
      id: `n:${n.requestId}`,
      refId: n.requestId,
      source: 'network',
      t: n.wallTime ?? 0,
      variant: n.failed || (n.status ?? 0) >= 500 ? 'error' : 'warning',
      label: n.failed ? 'failed' : String(n.status),
      summary: `${n.method} ${shortUrl(n.url)}`,
      actionable: true,
    });
  }
  return rows;
}

/** Derive page-action rows from the chat transcript's browser/runtime tool calls. */
export function buildAgentRows(messages: readonly AgentMessage[]): Row[] {
  const rows: Row[] = [];
  for (const m of messages) {
    for (const part of m.parts) {
      if (part.type !== 'tool') continue;
      const call = part.call;
      if (!PAGE_ACTION_TOOLS.has(call.name)) continue;
      const failed = call.state === 'error' || call.state === 'denied' || call.state === 'aborted';
      rows.push({
        id: `a:${call.id}`,
        refId: call.id,
        source: 'agent',
        t: m.timestamp,
        variant: failed ? 'error' : 'accent',
        label: call.name,
        summary: actionSummary(call),
        actionable: false,
      });
    }
  }
  return rows;
}
