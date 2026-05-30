import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Trash2 } from 'lucide-react';
import { cn } from '../../../lib/cn';
import { useDevtoolsStore } from '../store';
import { RemoteValue } from '../components/RemoteValue';
import type { ConsoleEntry } from '../types';

/**
 * Console panel: the live `consoleAPICalled` / `exceptionThrown` / `Log` stream
 * plus a `Runtime.evaluate` REPL. Logged objects expand inline (RemoteValue).
 */

const ROW_TINT: Partial<Record<ConsoleEntry['kind'], string>> = {
  error: 'bg-error/10 border-l-error',
  exception: 'bg-error/10 border-l-error',
  warning: 'bg-warning/10 border-l-warning',
};

function originText(entry: ConsoleEntry): string | null {
  if (!entry.url) return null;
  const file = entry.url.split('/').pop() || entry.url;
  return entry.lineNumber ? `${file}:${entry.lineNumber + 1}` : file;
}

function ConsoleRow({ entry }: { entry: ConsoleEntry }) {
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
    </div>
  );
}

export function ConsolePanel() {
  const entries = useDevtoolsStore((s) => s.console);
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  // Auto-scroll to the newest entry while pinned to the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [entries.length]);

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
      <div className="shrink-0 h-8 flex items-center px-1.5 border-b border-subtle">
        <button
          type="button"
          aria-label="Clear console"
          title="Clear console"
          onClick={() => useDevtoolsStore.getState().clearConsole()}
          className="size-6 rounded flex items-center justify-center text-fg-tertiary hover:text-fg-primary hover:bg-surface-2"
        >
          <Trash2 size={14} />
        </button>
      </div>

      <div ref={scrollRef} onScroll={onScroll} className="flex-1 min-h-0 overflow-auto">
        {entries.length === 0 ? (
          <div className="h-full flex items-center justify-center text-caption text-fg-tertiary">
            Console is empty
          </div>
        ) : (
          entries.map((e) => <ConsoleRow key={e.id} entry={e} />)
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
