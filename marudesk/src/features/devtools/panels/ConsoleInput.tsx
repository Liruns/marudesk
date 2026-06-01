import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '../../../lib/cn';
import {
  useDevtoolsStore,
  type CompletionItem,
  type CompletionResult,
} from '../store';

/**
 * The Console REPL input with Chrome-style as-you-type autocomplete.
 *
 * A plain <input> (the existing impl) + an absolutely-positioned dropdown of
 * ranked candidates anchored above it. Completion is computed by the store
 * (`getCompletions`) over CDP; this component owns only the UI: debounce, the
 * candidate list, keyboard nav, and accept/insert. An inline ghost-text hint
 * shows the remaining characters of the top match for token completions.
 *
 * Keyboard:
 *   - Tab / →          accept the highlighted candidate
 *   - ↑ / ↓            move the selection (when open); recall history (when closed)
 *   - Enter            accept if a candidate is highlighted, else evaluate
 *   - Esc              close the popup (stops propagation so the dock's Esc →
 *                      toggle-drawer doesn't also fire); no-op extra otherwise
 *   - Ctrl+Space       manually trigger (lists everything, even on an empty token)
 *
 * Completion failures are swallowed in the store, so typing/eval never blocks.
 */

const DEBOUNCE_MS = 100;

/** The remaining suffix of the top token-candidate, for the inline ghost hint. */
function ghostSuffix(c: CompletionResult | null): string {
  if (!c || c.items.length === 0) return '';
  const top = c.items[0];
  if (top.replace !== 'token' || !c.prefix) return '';
  // Only show ghost text when the candidate genuinely extends the typed prefix.
  if (top.text.length <= c.prefix.length) return '';
  if (!top.text.toLowerCase().startsWith(c.prefix.toLowerCase())) return '';
  return top.text.slice(c.prefix.length);
}

const KIND_DOT: Record<CompletionItem['kind'], string> = {
  property: 'bg-accent',
  global: 'bg-success',
  'command-api': 'bg-warning',
  history: 'bg-fg-tertiary',
};

export function ConsoleInput() {
  const [input, setInput] = useState('');
  const [completion, setCompletion] = useState<CompletionResult | null>(null);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const debounceRef = useRef<number | null>(null);
  // Monotonic request id: a slower in-flight completion can't overwrite a newer.
  const reqRef = useRef(0);
  // History cursor for ↑/↓ recall when the popup is closed (-1 = live input).
  const histRef = useRef(-1);
  // Caret to restore after a programmatic value change (controlled input).
  const pendingCaret = useRef<number | null>(null);

  const open = completion !== null && completion.items.length > 0;
  const ghost = open ? ghostSuffix(completion) : '';

  // Restore caret after we set the value programmatically (accept / history).
  useLayoutEffect(() => {
    if (pendingCaret.current !== null && inputRef.current) {
      const pos = pendingCaret.current;
      pendingCaret.current = null;
      inputRef.current.setSelectionRange(pos, pos);
    }
  }, [input]);

  // Keep the highlighted row in view.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.children[selected] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selected, open]);

  const close = useCallback(() => {
    reqRef.current++; // cancel any in-flight refresh
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setCompletion(null);
    setSelected(0);
  }, []);

  const runCompletion = useCallback(async (value: string, caret: number, force: boolean) => {
    const id = ++reqRef.current;
    const res = await useDevtoolsStore.getState().getCompletions(value, caret, force);
    if (id !== reqRef.current) return; // superseded
    if (res.items.length === 0) {
      setCompletion(null);
      setSelected(0);
      return;
    }
    setCompletion(res);
    setSelected(0);
  }, []);

  const scheduleCompletion = useCallback(
    (value: string, caret: number) => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => {
        debounceRef.current = null;
        void runCompletion(value, caret, false);
      }, DEBOUNCE_MS);
    },
    [runCompletion],
  );

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    const caret = e.target.selectionStart ?? value.length;
    histRef.current = -1;
    setInput(value);
    if (value.trim() === '') {
      close();
    } else {
      scheduleCompletion(value, caret);
    }
  };

  /** Replace the relevant slice with the item's text; close the popup. */
  const accept = (item: CompletionItem) => {
    const el = inputRef.current;
    const caret = el?.selectionStart ?? input.length;
    let next: string;
    let pos: number;
    if (item.replace === 'all') {
      next = item.text;
      pos = next.length;
    } else {
      const c = completion;
      const prefixLen = c ? c.prefix.length : 0;
      const start = Math.max(0, caret - prefixLen);
      next = input.slice(0, start) + item.text + input.slice(caret);
      pos = start + item.text.length;
    }
    pendingCaret.current = pos;
    setInput(next);
    close();
    el?.focus();
  };

  const submit = () => {
    const expr = input;
    if (!expr.trim()) return;
    setInput('');
    histRef.current = -1;
    close();
    void useDevtoolsStore.getState().evaluate(expr);
  };

  /** ↑/↓ history recall when the popup is closed. */
  const recallHistory = (delta: number) => {
    const hist = useDevtoolsStore.getState().commandHistory;
    if (hist.length === 0) return;
    let idx = histRef.current;
    if (idx === -1) idx = delta < 0 ? hist.length - 1 : -1;
    else idx = idx + delta;
    if (idx < 0) {
      histRef.current = -1;
      pendingCaret.current = 0;
      setInput('');
      return;
    }
    if (idx >= hist.length) idx = hist.length - 1;
    histRef.current = idx;
    const value = hist[idx];
    pendingCaret.current = value.length;
    setInput(value);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    // Manual trigger.
    if (e.key === ' ' && e.ctrlKey) {
      e.preventDefault();
      const el = e.currentTarget;
      void runCompletion(el.value, el.selectionStart ?? el.value.length, true);
      return;
    }

    if (open && completion) {
      const items = completion.items;
      switch (e.key) {
        case 'Escape':
          // Close the popup AND stop the event so the dock's Esc handler (toggle
          // drawer) doesn't also fire — the popup must win first (per spec).
          e.preventDefault();
          e.stopPropagation();
          close();
          return;
        case 'ArrowDown':
          e.preventDefault();
          setSelected((s) => (s + 1) % items.length);
          return;
        case 'ArrowUp':
          e.preventDefault();
          setSelected((s) => (s - 1 + items.length) % items.length);
          return;
        case 'Tab':
        case 'ArrowRight': {
          // → only accepts when the caret is at the end (otherwise it's normal
          // cursor movement); Tab always accepts.
          const el = e.currentTarget;
          const atEnd = (el.selectionStart ?? 0) >= el.value.length;
          if (e.key === 'ArrowRight' && !atEnd) {
            close();
            return;
          }
          e.preventDefault();
          accept(items[selected] ?? items[0]);
          return;
        }
        case 'Enter':
          // Popup open ⇒ a suggestion is always highlighted ⇒ Enter accepts it.
          // (With the popup closed, Enter evaluates — see the closed branch.)
          e.preventDefault();
          accept(items[selected] ?? items[0]);
          return;
        default:
          return;
      }
    }

    // Popup closed.
    switch (e.key) {
      case 'Enter':
        e.preventDefault();
        submit();
        return;
      case 'ArrowUp':
        e.preventDefault();
        recallHistory(-1);
        return;
      case 'ArrowDown':
        // Only recall forward when we're mid-history (don't hijack ↓ at rest).
        if (histRef.current !== -1) {
          e.preventDefault();
          recallHistory(1);
        }
        return;
      default:
        return;
    }
  };

  return (
    <div className="shrink-0 relative flex items-center gap-1.5 px-2 h-9 border-t border-subtle">
      <ChevronRight size={14} className="text-accent shrink-0" />
      <div className="relative flex-1 min-w-0">
        {/* Inline ghost-text hint (top token match), drawn under the input. */}
        {ghost ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 flex items-center font-mono text-caption whitespace-pre overflow-hidden"
          >
            <span className="invisible">{input}</span>
            <span className="text-fg-tertiary/60">{ghost}</span>
          </div>
        ) : null}
        <input
          ref={inputRef}
          value={input}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onBlur={close}
          spellCheck={false}
          autoComplete="off"
          placeholder="Evaluate JavaScript"
          aria-label="Console input"
          aria-autocomplete="list"
          aria-expanded={open}
          className="relative w-full bg-transparent font-mono text-caption text-fg-primary placeholder:text-fg-tertiary focus:outline-none"
        />

        {open && completion ? (
          <ul
            ref={listRef}
            role="listbox"
            aria-label="Completions"
            className="absolute bottom-full left-0 mb-1 max-h-60 w-72 max-w-[80vw] overflow-auto rounded-md border border-default bg-surface-2 shadow-xl py-1 z-50"
          >
            {completion.items.map((item, i) => (
              <li
                key={`${item.kind}:${item.text}`}
                role="option"
                aria-selected={i === selected}
                // Use onMouseDown (fires before the input's onBlur) so clicking a
                // row accepts it instead of just blurring the input shut.
                onMouseDown={(e) => {
                  e.preventDefault();
                  accept(item);
                }}
                onMouseEnter={() => setSelected(i)}
                className={cn(
                  'flex items-center gap-2 px-2 h-6 cursor-pointer font-mono text-caption',
                  i === selected
                    ? 'bg-accent/20 text-fg-primary'
                    : 'text-fg-secondary hover:bg-surface-3',
                )}
              >
                <span className={cn('size-1.5 rounded-full shrink-0', KIND_DOT[item.kind])} aria-hidden />
                <span className="flex-1 min-w-0 truncate">
                  {item.kind === 'history' ? (
                    <span className="text-fg-tertiary">{'> '}</span>
                  ) : null}
                  {item.text}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
