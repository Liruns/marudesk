import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  Regex,
  Search,
  WholeWord,
  X,
} from 'lucide-react';
import { Spinner } from '../../components/ui';
import { cn } from '../../lib/cn';
import type { SearchFileResult } from '../../../shared/search';
import { useSearchStore } from './store';
import { useEditorStore } from '../editor/store';
import { baseName, dirName } from '../git/statusMeta';

type Props = {
  open: boolean;
  onRequestClose?: () => void;
};

// Width persistence + drag-to-close, mirroring ExplorerPanel.
const S_MIN = 180;
const S_MAX = 600;
const S_DEFAULT = 320;
const S_WIDTH_KEY = 'marudesk.searchWidth';
const S_CLOSE_AT = 96;
const S_DRAG_FLOOR = 56;
const DEBOUNCE_MS = 250;

function readWidth(): number {
  try {
    const v = Number(localStorage.getItem(S_WIDTH_KEY));
    if (Number.isFinite(v) && v >= S_MIN && v <= S_MAX) return v;
  } catch {
    // localStorage unavailable — fall through to the default.
  }
  return S_DEFAULT;
}

/**
 * Left-hand content-search sidebar. A debounced query input with case/word/
 * regex toggles, results grouped by file (each group collapsible), and a click
 * on a result opens the file in the editor. The search itself runs in main
 * (search:content — ripgrep with a Node fallback); this panel just drives it.
 *
 * Reuses ExplorerPanel's resize/drag-to-close mechanics. Ctrl+Shift+F (handled
 * in Shell) opens the panel and bumps the store's focusNonce, which this panel
 * watches to focus its input.
 */
export function SearchPanel({ open, onRequestClose }: Props) {
  const query = useSearchStore((s) => s.query);
  const options = useSearchStore((s) => s.options);
  const result = useSearchStore((s) => s.result);
  const loading = useSearchStore((s) => s.loading);
  const error = useSearchStore((s) => s.error);
  const focusNonce = useSearchStore((s) => s.focusNonce);
  const setQuery = useSearchStore((s) => s.setQuery);
  const toggleOption = useSearchStore((s) => s.toggleOption);
  const run = useSearchStore((s) => s.run);
  const clear = useSearchStore((s) => s.clear);
  const openFile = useEditorStore((s) => s.openFile);

  const [width, setWidth] = useState(readWidth);
  const [resizing, setResizing] = useState(false);
  const [inCloseZone, setInCloseZone] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Debounced search as the user types. A trailing-edge timer keyed on the
  // query string; cleared on each keystroke so only the pause fires the search.
  useEffect(() => {
    const id = setTimeout(() => void run(query), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [query, run]);

  // Focus the input when the panel opens or Ctrl+Shift+F bumps the nonce.
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, [open, focusNonce]);

  const onResizeStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    const asideLeft = handle.parentElement?.getBoundingClientRect().left ?? 0;
    handle.setPointerCapture(e.pointerId);
    setResizing(true);
    let last = width;
    let lastGood = width >= S_MIN ? width : S_DEFAULT;
    const onMove = (ev: PointerEvent) => {
      last = Math.min(S_MAX, Math.max(S_DRAG_FLOOR, ev.clientX - asideLeft));
      if (last >= S_MIN) lastGood = last;
      setWidth(last);
      setInCloseZone(last < S_CLOSE_AT);
    };
    const onDone = () => {
      setResizing(false);
      setInCloseZone(false);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('lostpointercapture', onDone);
      if (last < S_CLOSE_AT) {
        const restore = lastGood >= S_MIN ? lastGood : S_DEFAULT;
        setWidth(restore);
        persistWidth(restore);
        onRequestClose?.();
      } else {
        const clamped = Math.min(S_MAX, Math.max(S_MIN, last));
        setWidth(clamped);
        persistWidth(clamped);
      }
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('lostpointercapture', onDone);
  };

  const totalMatches = useMemo(
    () => (result ? result.files.reduce((n, f) => n + f.matches.length, 0) : 0),
    [result],
  );

  const closeZoneActive = resizing && inCloseZone;

  return (
    <aside
      role="complementary"
      aria-label="Search"
      aria-hidden={!open}
      className={cn(
        'relative shrink-0 bg-surface-1 border-r border-subtle overflow-hidden',
        resizing ? '' : 'transition-[width] duration-standard',
      )}
      style={{ width: open ? width : 0 }}
    >
      <div
        className={cn(
          'h-full flex flex-col',
          closeZoneActive
            ? 'opacity-30 transition-opacity duration-fast'
            : 'transition-opacity duration-fast',
        )}
        style={{ width }}
      >
        <header className="h-9 shrink-0 flex items-center justify-between pl-3 pr-1.5 border-b border-subtle">
          <h2 className="text-caption font-medium uppercase tracking-wide text-fg-tertiary">
            Search
          </h2>
        </header>

        {/* query input + toggles */}
        <div className="shrink-0 p-2 border-b border-subtle">
          <div className="flex items-center gap-1.5 rounded border border-subtle bg-surface-2 px-2 h-8 focus-within:border-accent">
            <Search size={14} className="shrink-0 text-fg-tertiary" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void run(query);
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  clear();
                }
              }}
              placeholder="Search in files"
              spellCheck={false}
              autoComplete="off"
              className="flex-1 min-w-0 bg-transparent text-body-sm text-fg-primary placeholder:text-fg-tertiary focus:outline-none"
            />
            {query ? (
              <button
                type="button"
                onClick={clear}
                aria-label="Clear search"
                title="Clear"
                className="shrink-0 size-5 rounded flex items-center justify-center text-fg-tertiary hover:text-fg-primary hover:bg-surface-3"
              >
                <X size={13} />
              </button>
            ) : null}
            <Toggle
              label="Match case"
              active={options.caseSensitive}
              onClick={() => toggleOption('caseSensitive')}
            >
              <CaseSensitive size={14} />
            </Toggle>
            <Toggle
              label="Match whole word"
              active={options.wholeWord}
              onClick={() => toggleOption('wholeWord')}
            >
              <WholeWord size={14} />
            </Toggle>
            <Toggle
              label="Use regular expression"
              active={options.regex}
              onClick={() => toggleOption('regex')}
            >
              <Regex size={14} />
            </Toggle>
          </div>
          {result ? (
            <p className="mt-1.5 px-0.5 text-caption text-fg-tertiary tabular-nums">
              {totalMatches === 0
                ? 'No results'
                : `${totalMatches} result${totalMatches === 1 ? '' : 's'} in ${result.files.length} file${result.files.length === 1 ? '' : 's'}`}
              {result.truncated ? ' (showing first matches)' : ''}
            </p>
          ) : null}
        </div>

        {/* results */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {error ? (
            <p className="px-3 py-3 text-body-sm text-error break-words">{error}</p>
          ) : loading && !result ? (
            <div className="flex items-center justify-center gap-2 py-8 text-fg-tertiary">
              <Spinner size={16} /> Searching…
            </div>
          ) : result && result.files.length > 0 ? (
            result.files.map((file) => (
              <FileGroup
                key={file.path}
                file={file}
                collapsed={collapsed.has(file.path)}
                onToggle={() =>
                  setCollapsed((prev) => {
                    const next = new Set(prev);
                    if (next.has(file.path)) next.delete(file.path);
                    else next.add(file.path);
                    return next;
                  })
                }
                onOpen={() => void openFile(file.path)}
              />
            ))
          ) : query.trim() && !loading ? (
            <p className="px-3 py-6 text-center text-body-sm text-fg-tertiary">
              No results for “{query.trim()}”.
            </p>
          ) : (
            <p className="px-3 py-6 text-center text-caption text-fg-tertiary">
              Type to search file contents.
            </p>
          )}
        </div>
      </div>

      {open ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize Search"
          onPointerDown={onResizeStart}
          className={cn(
            'absolute inset-y-0 right-0 z-20 w-1 cursor-col-resize',
            'transition-colors duration-fast',
            closeZoneActive ? 'bg-error' : resizing ? 'bg-accent' : 'bg-transparent hover:bg-accent/60',
          )}
        >
          <span aria-hidden className="absolute inset-y-0 -left-1 right-0" />
          {closeZoneActive ? (
            <span
              aria-hidden
              className={cn(
                'absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2',
                'whitespace-nowrap px-2 py-1 rounded',
                'bg-surface-2 text-error text-caption pointer-events-none select-none',
              )}
            >
              Release to close
            </span>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}

/** One file's matches, collapsible, with a click-to-open header + match rows. */
function FileGroup({
  file,
  collapsed,
  onToggle,
  onOpen,
}: {
  file: SearchFileResult;
  collapsed: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const dir = dirName(file.path);
  return (
    <div>
      <div className="group/file flex items-center h-6 pl-1 pr-2 hover:bg-surface-2">
        <button
          type="button"
          onClick={onToggle}
          aria-label={collapsed ? 'Expand' : 'Collapse'}
          className="shrink-0 size-5 flex items-center justify-center text-fg-tertiary"
        >
          {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        </button>
        <button
          type="button"
          onClick={onOpen}
          title={file.path}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <span className="truncate text-body-sm text-fg-primary">{baseName(file.path)}</span>
          {dir ? <span className="truncate text-caption text-fg-tertiary">{dir}</span> : null}
        </button>
        <span className="shrink-0 text-caption text-fg-tertiary tabular-nums">
          {file.matches.length}
        </span>
      </div>
      {!collapsed
        ? file.matches.map((m, i) => (
            <button
              key={`${m.line}:${m.col}:${i}`}
              type="button"
              onClick={onOpen}
              title={`Line ${m.line}`}
              className="flex w-full items-baseline gap-2 py-0.5 pl-7 pr-2 text-left hover:bg-surface-2"
            >
              <span className="shrink-0 text-caption text-fg-tertiary tabular-nums w-8 text-right">
                {m.line}
              </span>
              <span className="truncate font-mono text-caption text-fg-secondary">
                {m.preview.trim()}
              </span>
            </button>
          ))
        : null}
    </div>
  );
}

function persistWidth(w: number): void {
  try {
    localStorage.setItem(S_WIDTH_KEY, String(Math.round(w)));
  } catch {
    // best-effort persistence
  }
}

function Toggle({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={cn(
        'shrink-0 size-6 rounded flex items-center justify-center transition-colors duration-fast',
        active
          ? 'bg-accent-subtle/40 text-accent'
          : 'text-fg-tertiary hover:text-fg-primary hover:bg-surface-3',
      )}
    >
      {children}
    </button>
  );
}
