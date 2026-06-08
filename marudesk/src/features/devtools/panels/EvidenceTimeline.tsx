import { useMemo, useState } from 'react';
import { Badge } from '../../../components/ui';
import { cn } from '../../../lib/cn';
import { askAgent, useAgentStore } from '../../agent/store';
import { useDevtoolsStore } from '../store';
import { buildAgentRows, buildProblemRows, type Row } from './evidence-rows';
import { buildNetworkFixPrompt } from './network-utils';

/**
 * Runtime evidence timeline — a read-only, chronological merge of what happened
 * on the live page, newest first, on a single wall-clock axis:
 *   - console errors/exceptions/warnings (console `timestamp`),
 *   - failed or 4xx/5xx network requests (network `wallTime`),
 *   - the agent's own page actions (click/fill/scroll/eval/reload/…), read
 *     straight from the chat transcript's tool calls (`message.timestamp`).
 *
 * Clicking a problem row jumps to its panel; its action hands it into the same
 * fix/triage loop the Console "Fix this" and Network detail use. Agent-action
 * rows are informational (the page-action log of §3.5/§3.9). A source filter
 * separates problems from actions. This is the main-side merger that §3.3 left
 * for later — done renderer-only, since tool calls are already in agent state.
 * Pure row-builders live in ./evidence-rows for unit testing.
 */

// Mirrors the Console panel's "Fix this" prompt (ConsolePanel onFix) so a
// timeline fix runs the same get_console_errors → edit → reload_and_verify loop.
const CONSOLE_FIX_PROMPT =
  "Fix this console error from the running page. It's attached from DevTools " +
  'with its source location — find the root cause in the source, fix it, then ' +
  'reload and verify the error is gone.';

type SourceFilter = 'all' | 'problems' | 'actions';

function clockLabel(t: number): string {
  if (!t) return '—';
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

const FILTERS: readonly { id: SourceFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'problems', label: 'Problems' },
  { id: 'actions', label: 'Actions' },
];

export function EvidenceTimeline() {
  const entries = useDevtoolsStore((s) => s.console);
  const network = useDevtoolsStore((s) => s.network);
  const setPanel = useDevtoolsStore((s) => s.setPanel);
  const captureConsoleError = useDevtoolsStore((s) => s.captureConsoleError);
  const messages = useAgentStore((s) => s.chat.messages);
  const [filter, setFilter] = useState<SourceFilter>('all');

  const rows = useMemo(() => {
    const problems = filter === 'actions' ? [] : buildProblemRows(entries, network);
    const actions = filter === 'problems' ? [] : buildAgentRows(messages);
    return [...problems, ...actions].sort((a, b) => b.t - a.t);
  }, [entries, network, messages, filter]);

  // Hand a row into the existing fix/triage loop: console → stage the error +
  // ask (same as Console "Fix this"); network → ask with the request identity
  // (same as the Network detail). Both reuse askAgent (open chat + send).
  const runAction = (row: Row) => {
    if (row.source === 'console') {
      captureConsoleError(row.refId);
      void askAgent(CONSOLE_FIX_PROMPT);
      return;
    }
    if (row.source === 'network') {
      const entry = network.find((n) => n.requestId === row.refId);
      if (entry) void askAgent(buildNetworkFixPrompt(entry));
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-subtle px-3 text-caption text-fg-tertiary">
        <span>Runtime evidence</span>
        <span className="flex items-center gap-0.5">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className={cn(
                'rounded px-1.5 py-0.5 transition-colors duration-fast',
                filter === f.id ? 'bg-surface-3 text-fg-secondary' : 'hover:text-fg-secondary',
              )}
            >
              {f.label}
            </button>
          ))}
        </span>
        <span className="flex-1" aria-hidden />
        <span className="tabular-nums">{rows.length}</span>
      </div>
      {rows.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-body-sm text-fg-tertiary">
          {filter === 'actions'
            ? 'No agent page actions on this page yet.'
            : filter === 'problems'
              ? 'No console errors or failed requests on this page yet.'
              : 'No runtime evidence on this page yet.'}
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
                onClick={() => {
                  if (row.source !== 'agent') setPanel(row.source);
                }}
                title={row.source === 'agent' ? 'Agent page action' : `Jump to ${row.source}`}
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
