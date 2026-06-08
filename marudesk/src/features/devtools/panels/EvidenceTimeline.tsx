import { useMemo } from 'react';
import { Badge } from '../../../components/ui';
import { cn } from '../../../lib/cn';
import { useDevtoolsStore } from '../store';
import type { ConsoleEntry, NetworkEntry } from '../types';

/**
 * Runtime evidence timeline — a read-only, chronological merge of what went
 * wrong on the live page: console errors/exceptions/warnings and failed or
 * 4xx/5xx network requests, newest first. Both sources are ordered on a single
 * wall-clock axis (console `timestamp`; network `wallTime`, captured at
 * `requestWillBeSent`), and each row jumps to the owning panel.
 *
 * MVP scope: console + network only. Navigation markers, agent page-actions, and
 * reload-verify rows are the later, main-side merger (see
 * docs/runtime-agent-absorption-2026-06.md §3.3); this renderer-only projection
 * reuses data already in the store and adds no IPC.
 */

type Row = {
  id: string;
  /** Wall-clock ms for ordering; 0 when a network row predates wallTime capture. */
  t: number;
  variant: 'error' | 'warning';
  label: string;
  summary: string;
  target: 'console' | 'network';
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
    return (u.pathname + u.search) || u.host;
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
      t: e.timestamp,
      variant: e.kind === 'warning' ? 'warning' : 'error',
      label: e.kind === 'exception' ? 'exception' : e.kind,
      summary: consoleSummary(e),
      target: 'console',
    });
  }
  for (const n of network) {
    const is4xx5xx = typeof n.status === 'number' && n.status >= 400;
    if (!n.failed && !is4xx5xx) continue;
    rows.push({
      id: `n:${n.requestId}`,
      t: n.wallTime ?? 0,
      variant: n.failed || (n.status ?? 0) >= 500 ? 'error' : 'warning',
      label: n.failed ? 'failed' : String(n.status),
      summary: `${n.method} ${shortUrl(n.url)}`,
      target: 'network',
    });
  }
  return rows.sort((a, b) => b.t - a.t);
}

export function EvidenceTimeline() {
  const entries = useDevtoolsStore((s) => s.console);
  const network = useDevtoolsStore((s) => s.network);
  const setPanel = useDevtoolsStore((s) => s.setPanel);
  const rows = useMemo(() => buildRows(entries, network), [entries, network]);

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
            <li key={row.id}>
              <button
                type="button"
                onClick={() => setPanel(row.target)}
                title={`Jump to ${row.target}`}
                className={cn(
                  'flex w-full items-center gap-2 border-b border-subtle/50 px-3 py-1.5 text-left',
                  'transition-colors duration-fast hover:bg-surface-2/50',
                )}
              >
                <span className="w-[58px] shrink-0 font-mono text-caption tabular-nums text-fg-tertiary">
                  {clockLabel(row.t)}
                </span>
                <Badge variant={row.variant}>{row.label}</Badge>
                <span className="min-w-0 flex-1 truncate text-body-sm text-fg-secondary">
                  {row.summary}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
