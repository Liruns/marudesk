import { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Sparkles, Trash2 } from 'lucide-react';
import { cn } from '../../../lib/cn';
import { toast } from '../../../lib/toast';
import { toMessage } from '../../../lib/toMessage';
import { useDevtoolsStore } from '../store';
import { askAgent } from '../../agent/store';
import { RemoteValue } from '../components/RemoteValue';
import { ConsoleInput } from './ConsoleInput';
import { useI18n } from '../../../i18n/useI18n';
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

/** `entry.timestamp` (epoch ms) → a `HH:MM:SS.mmm` gutter label. */
function fmtClock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** Plain-text rendering of an entry, for the clipboard. */
function entryToText(entry: ConsoleEntry): string {
  const parts: string[] = [];
  if (entry.text !== undefined) parts.push(entry.text);
  for (const a of entry.args) parts.push(remoteText(a));
  const origin = originText(entry);
  const body = parts.join(' ');
  return origin ? `${body}    ${origin}` : body;
}

/**
 * A run of identical adjacent entries collapsed into one row (Chrome's console
 * coalescing). `count` > 1 surfaces as a badge so a tight logging loop reads as
 * "message ×42" instead of 42 rows.
 */
type ConsoleRowModel = { entry: ConsoleEntry; count: number };

/** Whether a kind participates in coalescing — REPL echoes never collapse. */
function coalescible(kind: ConsoleKind): boolean {
  return !ALWAYS_KINDS.has(kind);
}

function ConsoleRow({
  entry,
  count,
  showTimestamp,
  onFix,
}: {
  entry: ConsoleEntry;
  count: number;
  showTimestamp: boolean;
  onFix?: () => void;
}) {
  const { t } = useI18n();
  const origin = originText(entry);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(entryToText(entry));
      toast({ title: 'Copied', variant: 'success' });
    } catch (err) {
      toast({ title: 'Copy failed', description: toMessage(err), variant: 'error' });
    }
  };
  return (
    <div
      // content-visibility skips layout/paint for off-screen rows so a 1,500-row
      // console stays smooth without a virtualization library.
      style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 24px' }}
      className={cn(
        'group px-2 py-1 border-b border-subtle/40 border-l-2 border-l-transparent flex gap-2 items-start',
        ROW_TINT[entry.kind],
      )}
    >
      <span className="shrink-0 mt-0.5 text-fg-tertiary font-mono text-caption select-none">
        {entry.kind === 'command' ? '›' : entry.kind === 'result' ? '‹' : ''}
      </span>
      {showTimestamp ? (
        <span className="shrink-0 mt-0.5 text-fg-tertiary font-mono text-caption tabular-nums select-none">
          {fmtClock(entry.timestamp)}
        </span>
      ) : null}
      {count > 1 ? (
        <span
          title={`${count} occurrences`}
          className="shrink-0 mt-0.5 min-w-4 h-4 px-1 rounded-pill bg-surface-3 text-fg-secondary text-[10px] leading-4 text-center tabular-nums font-medium"
        >
          {count}
        </span>
      ) : null}
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
      <button
        type="button"
        onClick={() => void copy()}
        title={t('devtools.console.copyMessage')}
        aria-label={t('devtools.console.copyMessage')}
        className="shrink-0 size-5 mt-0.5 rounded items-center justify-center text-fg-tertiary hover:text-fg-primary hover:bg-surface-2 hidden group-hover:flex"
      >
        <Copy size={12} />
      </button>
      {origin ? (
        <span className="shrink-0 text-caption text-fg-tertiary font-mono">{origin}</span>
      ) : null}
      {onFix ? (
        <button
          type="button"
          onClick={onFix}
          title={t('devtools.console.fixError')}
          className="shrink-0 inline-flex items-center gap-1 rounded px-1.5 h-5 mt-0.5 text-caption text-accent hover:bg-accent-subtle/40 transition-colors duration-fast"
        >
          <Sparkles size={11} />
          Fix this
        </button>
      ) : null}
    </div>
  );
}

/** Per-level counts for the filter-button badges (errors fold in exceptions). */
function countByLevel(entries: ConsoleEntry[]): Record<Exclude<LevelFilter, 'all'>, number> {
  const counts = { error: 0, warning: 0, info: 0, log: 0, debug: 0 };
  for (const e of entries) {
    if (e.kind === 'error' || e.kind === 'exception') counts.error++;
    else if (e.kind === 'warning') counts.warning++;
    else if (e.kind === 'info') counts.info++;
    else if (e.kind === 'log') counts.log++;
    else if (e.kind === 'debug') counts.debug++;
  }
  return counts;
}

export function ConsolePanel() {
  const { t } = useI18n();
  const entries = useDevtoolsStore((s) => s.console);
  const preserveLog = useDevtoolsStore((s) => s.preserveLog);
  const showTimestamps = useDevtoolsStore((s) => s.showTimestamps);
  // No composer in the pop-out DevTools window → hide "Fix this" there.
  const windowMode = useDevtoolsStore((s) => s.windowMode);
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

  // Collapse runs of identical adjacent entries into counted rows.
  const rows = useMemo<ConsoleRowModel[]>(() => {
    const out: ConsoleRowModel[] = [];
    let lastSig: string | null = null;
    for (const e of visible) {
      const sig = coalescible(e.kind) ? `${e.kind} ${entryText(e)}` : null;
      const last = out[out.length - 1];
      if (last && sig !== null && sig === lastSig) {
        last.count++;
      } else {
        out.push({ entry: e, count: 1 });
        lastSig = sig;
      }
    }
    return out;
  }, [visible]);

  const counts = useMemo(() => countByLevel(entries), [entries]);

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(visible.map(entryToText).join('\n'));
      toast({ title: `Copied ${visible.length} messages`, variant: 'success' });
    } catch (err) {
      toast({ title: 'Copy failed', description: toMessage(err), variant: 'error' });
    }
  };

  // Auto-scroll to the newest entry while pinned to the bottom. A fresh REPL
  // echo (command/result) re-pins, so submitting an expression always scrolls
  // down even if the user had scrolled up to read earlier output.
  const newestKind = visible.length ? visible[visible.length - 1].kind : null;
  useEffect(() => {
    if (newestKind === 'command' || newestKind === 'result') pinnedRef.current = true;
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [rows.length, newestKind]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="shrink-0 flex items-center gap-1 px-1.5 py-1 border-b border-subtle flex-wrap">
        <button
          type="button"
          aria-label={t('devtools.console.clear')}
          title={t('devtools.console.clear')}
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
          placeholder={t('devtools.console.filter')}
          aria-label={t('devtools.console.filterAria')}
          className="h-6 w-28 min-w-0 rounded bg-surface-2 px-2 text-caption text-fg-primary placeholder:text-fg-tertiary focus:outline-none focus:ring-1 focus:ring-accent/50"
        />
        <div className="flex items-center gap-0.5">
          {LEVEL_FILTERS.map((f) => {
            const n = f.id === 'all' ? 0 : counts[f.id];
            return (
              <button
                key={f.id}
                type="button"
                aria-pressed={level === f.id}
                onClick={() => setLevel(f.id)}
                className={cn(
                  'h-6 px-1.5 rounded text-caption transition-colors duration-fast inline-flex items-center gap-1',
                  level === f.id
                    ? 'bg-surface-page text-fg-primary'
                    : 'text-fg-tertiary hover:text-fg-secondary hover:bg-surface-2',
                )}
              >
                {f.label}
                {n > 0 ? (
                  <span
                    className={cn(
                      'tabular-nums text-[10px]',
                      f.id === 'error'
                        ? 'text-error'
                        : f.id === 'warning'
                          ? 'text-warning'
                          : 'text-fg-tertiary',
                    )}
                  >
                    {n > 999 ? '999+' : n}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
        <div className="ml-auto flex items-center gap-1 whitespace-nowrap">
          <button
            type="button"
            aria-label={t('devtools.console.copyAll')}
            title={t('devtools.console.copyAllTitle')}
            disabled={visible.length === 0}
            onClick={() => void copyAll()}
            className="size-6 shrink-0 rounded flex items-center justify-center text-fg-tertiary hover:text-fg-primary hover:bg-surface-2 disabled:opacity-40"
          >
            <Copy size={13} />
          </button>
          <label className="flex items-center gap-1 px-1 text-caption text-fg-tertiary cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showTimestamps}
              onChange={(e) => useDevtoolsStore.getState().setShowTimestamps(e.target.checked)}
              className="accent-accent"
            />
            Timestamps
          </label>
          <label className="flex items-center gap-1 px-1 text-caption text-fg-tertiary cursor-pointer select-none">
            <input
              type="checkbox"
              checked={preserveLog}
              onChange={(e) => useDevtoolsStore.getState().setPreserveLog(e.target.checked)}
              className="accent-accent"
            />
            Preserve log
          </label>
        </div>
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
          rows.map(({ entry: e, count }) => (
            <ConsoleRow
              key={e.id}
              entry={e}
              count={count}
              showTimestamp={showTimestamps}
              onFix={
                !windowMode && (e.kind === 'error' || e.kind === 'exception')
                  ? () => {
                      // Stage the error (with its source mapping) as a selected
                      // capture, then open the chat and fire the existing
                      // get_console_errors → edit → reload_and_verify loop.
                      useDevtoolsStore.getState().captureConsoleError(e.id);
                      void askAgent(
                        "Fix this console error from the running page. It's attached " +
                          'from DevTools with its source location — find the root cause ' +
                          'in the source, fix it, then reload and verify the error is gone.',
                      );
                    }
                  : undefined
              }
            />
          ))
        )}
      </div>

      <ConsoleInput />
    </div>
  );
}
