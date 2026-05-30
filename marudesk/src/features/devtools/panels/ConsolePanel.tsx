import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Sparkles, Trash2 } from 'lucide-react';
import { cn } from '../../../lib/cn';
import { useDevtoolsStore } from '../store';
import { RemoteValue } from '../components/RemoteValue';
import type { ConsoleEntry, ConsoleKind, RemoteObject } from '../types';

/**
 * Console panel: the live `consoleAPICalled` / `exceptionThrown` / `Log` stream
 * plus a `Runtime.evaluate` REPL. Logged objects expand inline (RemoteValue).
 * A level filter (by kind) + text filter narrow the rendered rows; REPL echoes
 * (command/result) always show so your own input/output is never hidden. A
 * "Preserve log" toggle keeps entries across navigations (store flag).
 */

const ROW_TINT: Partial<Record<ConsoleEntry['kind'], string>> = {
  error: 'bg-error/10 border-l-error',
  exception: 'bg-error/10 border-l-error',
  warning: 'bg-warning/10 border-l-warning',
};

/** Level-filter buttons → the set of kinds each admits (besides REPL echoes). */
type LevelFilter = 'all' | 'error' | 'warning' | 'info' | 'log' | 'debug';
const LEVEL_FILTERS: { id: LevelFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'error', label: 'Errors' },
  { id: 'warning', label: 'Warnings' },
  { id: 'info', label: 'Info' },
  { id: 'log', label: 'Logs' },
  { id: 'debug', label: 'Debug' },
];
const LEVEL_KINDS: Record<Exclude<LevelFilter, 'all'>, ConsoleKind[]> = {
  error: ['error', 'exception'],
  warning: ['warning'],
  info: ['info'],
  log: ['log'],
  debug: ['debug'],
};
// REPL input/output always shows regardless of the level filter.
const ALWAYS_KINDS: ReadonlySet<ConsoleKind> = new Set<ConsoleKind>([
  'command',
  'result',
]);

/** A single RemoteObject → its searchable text (for the substring text filter). */
function remoteText(obj: RemoteObject): string {
  if (obj.value !== undefined) return String(obj.value);
  return obj.description ?? obj.unserializableValue ?? obj.className ?? obj.type;
}

/** All searchable text for an entry: its pre-rendered text + each arg. */
function entryText(entry: ConsoleEntry): string {
  const parts: string[] = [];
  if (entry.text) parts.push(entry.text);
  for (const a of entry.args) parts.push(remoteText(a));
  if (entry.url) parts.push(entry.url);
  return parts.join(' ').toLowerCase();
}

function originText(entry: ConsoleEntry): string | null {
  if (!entry.url) return null;
  const file = entry.url.split('/').pop() || entry.url;
  return entry.lineNumber ? `${file}:${entry.lineNumber + 1}` : file;
}

function ConsoleRow({ entry, onFix }: { entry: ConsoleEntry; onFix?: () => void }) {
  const origin = originText(entry);
  return (
    <div
      className={cn(
        'px-2 py-1 border-b border-subtle/40 border-l-2 border-l-transparent flex gap-2 items-start',
        ROW_TINT[entry.kind],
      )}
    >
      <span className="shrink-0 mt-0.5 text-fg-tertiary font-mono text-caption select-none">
        {entry.kind === 'command' ? '›' : entry.kind === 'result' ? '‹' : ''}
      </span>
      <div className="flex-1 min-w-0 flex flex-wrap gap-x-2 gap-y-0.5 items-start">
        {entry.text !== undefined ? (
          <span
            className={cn(
              'font-mono text-caption whitespace-pre-wrap break-words',
              entry.kind === 'command'
                ? 'text-fg-secondary'
                : entry.kind === 'exception' || entry.kind === 'error'
                  ? 'text-error'
                  : 'text-fg-primary',
            )}
          >
            {entry.text}
          </span>
        ) : null}
        {entry.args.map((arg, i) => (
          <RemoteValue key={i} obj={arg} expandable />
        ))}
      </div>
      {origin ? (
        <span className="shrink-0 text-caption text-fg-tertiary font-mono">{origin}</span>
      ) : null}
      {onFix ? (
        <button
          type="button"
          onClick={onFix}
          title="Add this error to the AI context"
          className="shrink-0 inline-flex items-center gap-1 rounded px-1.5 h-5 mt-0.5 text-caption text-accent hover:bg-accent-subtle/40 transition-colors duration-fast"
        >
          <Sparkles size={11} />
          Fix this
        </button>
      ) : null}
    </div>
  );
}

export function ConsolePanel() {
  const entries = useDevtoolsStore((s) => s.console);
  const preserveLog = useDevtoolsStore((s) => s.preserveLog);
  // No composer in the pop-out DevTools window → hide "Fix this" there.
  const windowMode = useDevtoolsStore((s) => s.windowMode);
  const [input, setInput] = useState('');
  const [level, setLevel] = useState<LevelFilter>('all');
  const [query, setQuery] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const kinds = level === 'all' ? null : new Set(LEVEL_KINDS[level]);
    if (!kinds && !q) return entries;
    return entries.filter((e) => {
      if (kinds && !ALWAYS_KINDS.has(e.kind) && !kinds.has(e.kind)) return false;
      if (q && !entryText(e).includes(q)) return false;
      return true;
    });
  }, [entries, level, query]);

  // Auto-scroll to the newest entry while pinned to the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [visible.length]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const expr = input;
    if (!expr.trim()) return;
    setInput('');
    pinnedRef.current = true;
    void useDevtoolsStore.getState().evaluate(expr);
  };

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="shrink-0 flex items-center gap-1 px-1.5 py-1 border-b border-subtle flex-wrap">
        <button
          type="button"
          aria-label="Clear console"
          title="Clear console"
          onClick={() => useDevtoolsStore.getState().clearConsole()}
          className="size-6 shrink-0 rounded flex items-center justify-center text-fg-tertiary hover:text-fg-primary hover:bg-surface-2"
        >
          <Trash2 size={14} />
        </button>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          placeholder="Filter"
          aria-label="Filter console"
          className="h-6 w-28 min-w-0 rounded bg-surface-2 px-2 text-caption text-fg-primary placeholder:text-fg-tertiary focus:outline-none focus:ring-1 focus:ring-accent/50"
        />
        <div className="flex items-center gap-0.5">
          {LEVEL_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={level === f.id}
              onClick={() => setLevel(f.id)}
              className={cn(
                'h-6 px-1.5 rounded text-caption transition-colors duration-fast',
                level === f.id
                  ? 'bg-surface-page text-fg-primary'
                  : 'text-fg-tertiary hover:text-fg-secondary hover:bg-surface-2',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <label className="ml-auto flex items-center gap-1 px-1 text-caption text-fg-tertiary cursor-pointer select-none whitespace-nowrap">
          <input
            type="checkbox"
            checked={preserveLog}
            onChange={(e) => useDevtoolsStore.getState().setPreserveLog(e.target.checked)}
            className="accent-accent"
          />
          Preserve log
        </label>
      </div>

      <div ref={scrollRef} onScroll={onScroll} className="flex-1 min-h-0 overflow-auto">
        {entries.length === 0 ? (
          <div className="h-full flex items-center justify-center text-caption text-fg-tertiary">
            Console is empty
          </div>
        ) : visible.length === 0 ? (
          <div className="h-full flex items-center justify-center text-caption text-fg-tertiary">
            No matching messages
          </div>
        ) : (
          visible.map((e) => (
            <ConsoleRow
              key={e.id}
              entry={e}
              onFix={
                !windowMode && (e.kind === 'error' || e.kind === 'exception')
                  ? () => useDevtoolsStore.getState().captureConsoleError(e.id)
                  : undefined
              }
            />
          ))
        )}
      </div>

      <form
        onSubmit={submit}
        className="shrink-0 flex items-center gap-1.5 px-2 h-9 border-t border-subtle"
      >
        <ChevronRight size={14} className="text-accent shrink-0" />
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          placeholder="Evaluate JavaScript"
          aria-label="Console input"
          className="flex-1 min-w-0 bg-transparent font-mono text-caption text-fg-primary placeholder:text-fg-tertiary focus:outline-none"
        />
      </form>
    </div>
  );
}
