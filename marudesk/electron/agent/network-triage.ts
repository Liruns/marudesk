import { scrubText, scrubHeaders } from '../../shared/scrub';
import { clipText as clip } from '../../shared/text-clip';
import type { NetworkRecord } from '../../shared/network-evidence';
import { getTerminalList, getTerminalOutput } from '../terminal';
import { getWorkspaceSnapshot } from '../workspace';
import { getNetwork } from '../browser/state';
import type { ToolContext, ToolResult } from './tools';
import { requireTab } from './tools/shared-helpers.ts';

/**
 * The `triage_network_failure` tool: full-stack correlation for one captured
 * request. Given a requestId (from read_network) it summarizes the request,
 * then scans EVERY open integrated terminal's recent scrollback tail for
 * correlated backend evidence — lines mentioning the request's path segments,
 * 4xx/5xx codes, stack-trace frames, or error keywords. Terminal scrollback
 * carries no timestamps, so correlation is "recent tail" (last
 * {@link TAIL_LINES} lines per terminal), which matches the reproduce-then-
 * triage flow. Excerpts are secret-scrubbed at egress exactly like
 * read_terminal, and the result ends with the open workspace roots so the
 * model knows a backend root may be the place to edit.
 *
 * Lives in the context layer (next to context-executors), not tools/: it reads
 * the terminal subsystem, and tools/ must stay import-cycle-free of
 * electron/terminal.ts (terminal → server/companion → agent/loop → tools).
 * Registered in CONTEXT_TOOLS with read_terminal's approval class (gated).
 */

const TAIL_LINES = 200;
const MAX_MATCHES_PER_TERMINAL = 20;
/** Path segments shorter than this are too generic to correlate on (api, v1…). */
const MIN_SEGMENT_CHARS = 3;

const STATUS_CODE = /\b[45]\d{2}\b/;
const ERROR_KEYWORD = /\b(error|exception|traceback|unhandled|fail(?:ed|ure)?|fatal|panic|warn(?:ing)?)\b/i;
const STACK_FRAME = /^\s+(at\s|File ")/;

/** Meaningful path segments of a URL for scrollback matching. */
function pathSegments(url: string): { pathname: string; segments: string[] } {
  try {
    const u = new URL(url);
    const segments = u.pathname
      .split('/')
      .filter((s) => s.length >= MIN_SEGMENT_CHARS && !/^\d+$/.test(s));
    return { pathname: u.pathname, segments };
  } catch {
    return { pathname: '', segments: [] };
  }
}

type MatchedLine = { line: string; pathHit: boolean };

/** Scan one terminal's tail for correlated lines (path hits first, bounded). */
function correlateLines(tail: string[], pathname: string, segments: string[]): MatchedLine[] {
  const matches: MatchedLine[] = [];
  for (const line of tail) {
    const pathHit =
      (pathname.length > 1 && line.includes(pathname)) || segments.some((s) => line.includes(s));
    const evidenceHit = STATUS_CODE.test(line) || ERROR_KEYWORD.test(line) || STACK_FRAME.test(line);
    if (pathHit || evidenceHit) matches.push({ line, pathHit });
  }
  if (matches.length <= MAX_MATCHES_PER_TERMINAL) return matches;
  // Over budget: keep every path-correlated line first, then fill with the
  // most recent generic error evidence.
  const pathLines = matches.filter((m) => m.pathHit);
  const rest = matches.filter((m) => !m.pathHit);
  return [...pathLines, ...rest.slice(-(MAX_MATCHES_PER_TERMINAL - Math.min(pathLines.length, MAX_MATCHES_PER_TERMINAL)))]
    .slice(0, MAX_MATCHES_PER_TERMINAL);
}

function requestSummary(r: NetworkRecord): string {
  const status = r.failed
    ? `FAILED (${r.errorText ?? 'unknown'})`
    : `${r.status ?? '?'} ${r.statusText ?? ''}`.trim();
  const hdrs = r.responseHeaders ? scrubHeaders(r.responseHeaders) : {};
  const ct = hdrs['content-type'] ?? hdrs['Content-Type'];
  const ageS = Math.max(0, Math.round((Date.now() - r.timestamp) / 1000));
  return [
    `Request [${r.requestId}]: ${scrubText(r.url) || '(url n/a)'}`,
    `Status: ${status}${r.resourceType ? `  type: ${r.resourceType}` : ''}${ct ? `  content-type: ${ct}` : ''}`,
    `Observed: ~${ageS}s ago`,
  ].join('\n');
}

/** The open workspace roots, so the model knows a backend root may exist. */
function rootsHint(): string {
  const snap = getWorkspaceSnapshot();
  const active = snap.workspaces.find((w) => w.id === snap.activeWorkspaceId) ?? snap.workspaces[0];
  if (!active || active.roots.length === 0) return 'No workspace is open — backend code is not reachable via file tools.';
  const roots = active.roots.map((r) => `${r.name} (${r.root})`).join(', ');
  return active.roots.length > 1
    ? `Workspace roots: ${roots}. A failing API usually originates in a backend root — use list_workspaces + read_workspace_file to read/edit it.`
    : `Workspace root: ${roots}. If the backend lives elsewhere, only its terminal output above is visible.`;
}

export async function triageNetworkFailure(
  input: { requestId?: unknown },
  ctx: ToolContext,
): Promise<ToolResult> {
  requireTab(ctx);
  const requestId = typeof input.requestId === 'string' ? input.requestId : '';
  if (!requestId) throw new Error('triage_network_failure requires "requestId" (from read_network)');
  const record = getNetwork(ctx.tabId!).find((r) => r.requestId === requestId);
  if (!record) {
    return {
      summary: `triage ${requestId}`,
      text: `no captured request with id ${requestId} — call read_network first (the buffer holds recent requests only)`,
      isError: true,
    };
  }
  const { pathname, segments } = pathSegments(record.url);
  const terminals = getTerminalList();
  const blocks: string[] = [requestSummary(record)];

  if (terminals.length === 0) {
    blocks.push('No integrated terminal is open — no backend output to correlate. If the user runs the backend elsewhere, ask them for its logs.');
  } else {
    let any = false;
    for (const t of terminals) {
      const out = getTerminalOutput(t.id);
      if (!out || !out.output.trim()) continue;
      const tail = out.output.split('\n').slice(-TAIL_LINES);
      const matched = correlateLines(tail, pathname, segments);
      if (matched.length === 0) continue;
      any = true;
      const pathHits = matched.filter((m) => m.pathHit).length;
      const label = pathHits > 0 ? `${pathHits} line(s) mention the request path` : 'generic error evidence only (no path match)';
      const excerpt = matched.map((m) => `${m.pathHit ? '>' : ' '} ${scrubText(m.line)}`).join('\n');
      blocks.push(`Terminal ${t.id} — ${label} (last ${TAIL_LINES} lines scanned):\n${excerpt}`);
    }
    if (!any) {
      blocks.push(`Scanned ${terminals.length} terminal(s) (last ${TAIL_LINES} lines each): no correlated path/error lines. The backend may not log this route, or the failure is client-side/infra (CORS, DNS, proxy). Reproduce the request, then re-run this triage.`);
    }
  }
  blocks.push(rootsHint());
  return {
    summary: `triage ${requestId} across ${terminals.length} terminal${terminals.length === 1 ? '' : 's'}`,
    text: clip(blocks.join('\n\n')),
  };
}
