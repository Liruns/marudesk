import { useMemo } from 'react';
import { Badge } from '../../../components/ui';
import { cn } from '../../../lib/cn';
import { askAgent } from '../../agent/store';
import { useDevtoolsStore } from '../store';
import type { ConsoleEntry, NetworkEntry } from '../types';
import { buildNetworkFixPrompt } from './network-utils';

/**
 * Runtime evidence timeline — a read-only, chronological merge of what went
 * wrong on the live page: console errors/exceptions/warnings and failed or
 * 4xx/5xx network requests, newest first. Both sources are ordered on a single
 * wall-clock axis (console `timestamp`; network `wallTime`, captured at
 * `requestWillBeSent`). Clicking a row jumps to the owning panel; the row's
 * action hands it straight into the existing fix/triage loop — the same handlers
 * the Console "Fix this" and Network detail use, so the timeline is an entry
 * point, not just a viewer.
 *
 * MVP scope: console + network only. Navigation markers, agent page-actions, and
 * reload-verify rows are the later, main-side merger (see
 * docs/runtime-agent-absorption-2026-06.md §3.3).
 */

// Mirrors the Console panel's "Fix this" prompt (ConsolePanel onFix) so a
// timeline fix runs the same get_console_errors → edit → reload_and_verify loop.
const CONSOLE_FIX_PROMPT =
  "Fix this console error from the running page. It's attached from DevTools " +
  'with its source location — find the root cause in the source, fix it, then ' +
  'reload and verify the error is gone.';

type Row = {
  id: string;
  /** console entry id or network requestId — used to run the row's action. */
  refId: string;
  source: 'console' | 'network';
  /** Wall-clock ms for ordering; 0 when a network row predates wallTime capture. */
  t: number;
  variant: 'error' | 'warning';
  label: string;
  summary: string;
  /** Whether the row offers a fix/triage action (console warnings can't be fixed). */
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

function clockLabel(t: number): string {
  if (!t) return '—';
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function buildRows(entries: ConsoleEntry[], network: NetworkEntry[]): Row[] {
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
  return rows.sort((a, b) => b.t - a.t);
}

export function EvidenceTimeline() {
  const entries = useDevtoolsStore((s) => s.console);
  const network = useDevtoolsStore((s) => s.network);
  const setPanel = useDevtoolsStore((s) => s.setPanel);
  const captureConsoleError = useDevtoolsStore((s) => s.captureConsoleError);
  const rows = useMemo(() => buildRows(entries, network), [entries, network]);

  // Hand a row into the existing fix/triage loop: console → stage the error +
  // ask (same as Console "Fix this"); network → ask with the request identity
  // (same as the Network detail). Both reuse askAgent (open chat + send).
  const runAction = (row: Row) => {
    if (row.source === 'console') {
      captureConsoleError(row.refId);
      void askAgent(CONSOLE_FIX_PROMPT);
      return;
    }
    const entry = network.find((n) => n.requestId === row.refId);
    if (entry) void askAgent(buildNetworkFixPrompt(entry));
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-subtle px-3 text-caption text-fg-tertiary">
        <span>Runtime evidence</span>
        <span className="tabular-nums">{rows.length}</span>
      </div>
      {rows.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-body-sm text-fg-tertiary">
          No console errors or failed requests on this page yet.
        </div>
      ) : (
        <ul className="flex-1 overflow-y-auto">
          {rows.map((row) => (
            <li
              key={row.id}
              className="group flex items-center gap-2 border-b border-subtle/50 pr-2 transition-colors duration-fast hover:bg-surface-2/50"
            >
              <button
                type="button"
                onClick={() => setPanel(row.source)}
                title={`Jump to ${row.source}`}
                className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left"
              >
                <span className="w-[58px] shrink-0 font-mono text-caption tabular-nums text-fg-tertiary">
                  {clockLabel(row.t)}
                </span>
                <Badge variant={row.variant}>{row.label}</Badge>
                <span className="min-w-0 flex-1 truncate text-body-sm text-fg-secondary">
                  {row.summary}
                </span>
              </button>
              {row.actionable ? (
                <button
                  type="button"
                  onClick={() => runAction(row)}
                  className={cn(
                    'shrink-0 rounded px-2 py-0.5 text-caption font-medium',
                    'text-accent opacity-0 transition-opacity duration-fast',
                    'hover:bg-accent-subtle group-hover:opacity-100 focus-visible:opacity-100',
                  )}
                >
                  {row.source === 'network' ? 'Triage' : 'Fix this'}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
