import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  CaseSensitive,
  ChevronsDownUp,
  ChevronsUpDown,
  Regex,
  Search,
  SlidersHorizontal,
  WholeWord,
  X,
} from 'lucide-react';
import { Spinner } from '../../components/ui';
import { useI18n } from '../../i18n/useI18n';
import { cn } from '../../lib/cn';
import { readStoredWidth, writeStoredWidth } from '../../lib/panelWidth';
import { useSearchStore } from './store';
import { openFileInstrument } from '../work-graph/instrument';
import { FileGroup, Toggle } from './SearchPanel.parts';

type Props = {
  open: boolean;
  onRequestClose?: () => void;
  /**
   * Render as a full-area Mission Control instrument instead of the fixed-width
   * rail. Drops the rail chrome (fixed width / collapse, resize + drag-to-close
   * handle) since InstrumentStage hosts the surface and owns "← Graph".
   */
  embedded?: boolean;
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
  return readStoredWidth(S_WIDTH_KEY, S_MIN, S_MAX, S_DEFAULT);
}

/**
 * Left-hand content-search sidebar. A debounced query input with case/word/
 * regex toggles plus include/exclude glob filters, results grouped by file
 * (each group collapsible) with matches highlighted in the preview, and a click
 * on a match opens the file at that line/column. The search itself runs in main
 * (search:content — ripgrep with a Node fallback); this panel just drives it.
 *
 * Reuses ExplorerPanel's resize/drag-to-close mechanics. Ctrl+Shift+F (handled
 * in Shell) opens the panel and bumps the store's focusNonce, which this panel
 * watches to focus its input.
 */
export function SearchPanel({ open, onRequestClose, embedded = false }: Props) {
  const {
    formatSearchMatchLineTitle,
    formatSearchNoResults,
    formatSearchSummary,
    t,
  } = useI18n();
  const query = useSearchStore((s) => s.query);
  const options = useSearchStore((s) => s.options);
  const result = useSearchStore((s) => s.result);
  const loading = useSearchStore((s) => s.loading);
  const error = useSearchStore((s) => s.error);
  const focusNonce = useSearchStore((s) => s.focusNonce);
  const setQuery = useSearchStore((s) => s.setQuery);
  const toggleOption = useSearchStore((s) => s.toggleOption);
  const setFilter = useSearchStore((s) => s.setFilter);
  const run = useSearchStore((s) => s.run);
  const clear = useSearchStore((s) => s.clear);

  const [width, setWidth] = useState(readWidth);
  const [resizing, setResizing] = useState(false);
  const [inCloseZone, setInCloseZone] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  // Open the include/exclude fields automatically if a filter is already set.
  const [showFilters, setShowFilters] = useState(
    () => !!(options.includes || options.excludes),
  );
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Debounced search as the user types or flips an option. A trailing-edge timer
  // keyed on the query + options; cleared on each change so only the pause fires
  // the search (and toggles/filters re-run through the same single path).
  useEffect(() => {
    const id = setTimeout(() => void run(query), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [query, options, run]);

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
  const hasResults = !!result && result.files.length > 0;

  return (
    <aside
      role="complementary"
      aria-label={t('search.panelLabel')}
      aria-hidden={embedded ? undefined : !open}
      className={cn(
        'bg-surface-1 overflow-hidden',
        embedded
          ? 'relative flex-1 min-w-0 h-full'
          : 'relative shrink-0 border-r border-subtle',
        embedded || resizing ? '' : 'transition-[width] duration-standard',
      )}
      style={embedded ? undefined : { width: open ? width : 0 }}
    >
      <div
        className={cn(
          'h-full flex flex-col',
          closeZoneActive
            ? 'opacity-30 transition-opacity duration-fast'
            : 'transition-opacity duration-fast',
        )}
        style={embedded ? undefined : { width }}
      >
        <header className="h-9 shrink-0 flex items-center justify-between pl-3 pr-1.5 border-b border-subtle">
          <h2 className="text-caption font-medium uppercase tracking-wide text-fg-tertiary">
            {t('search.panelLabel')}
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
              placeholder={t('search.placeholder')}
              spellCheck={false}
              autoComplete="off"
              className="flex-1 min-w-0 bg-transparent text-body-sm text-fg-primary placeholder:text-fg-tertiary focus:outline-none"
            />
            {query ? (
              <button
                type="button"
                onClick={clear}
                aria-label={t('search.clear')}
                title={t('search.clear')}
                className="shrink-0 size-5 rounded flex items-center justify-center text-fg-tertiary hover:text-fg-primary hover:bg-surface-3"
              >
                <X size={13} />
              </button>
            ) : null}
            <Toggle
              label={t('search.toggle.caseSensitive')}
              active={options.caseSensitive}
              onClick={() => toggleOption('caseSensitive')}
            >
              <CaseSensitive size={14} />
            </Toggle>
            <Toggle
              label={t('search.toggle.wholeWord')}
              active={options.wholeWord}
              onClick={() => toggleOption('wholeWord')}
            >
              <WholeWord size={14} />
            </Toggle>
            <Toggle
              label={t('search.toggle.regex')}
              active={options.regex}
              onClick={() => toggleOption('regex')}
            >
              <Regex size={14} />
            </Toggle>
            <Toggle
              label={t('search.toggle.filters')}
              active={showFilters || !!(options.includes || options.excludes)}
              onClick={() => setShowFilters((v) => !v)}
            >
              <SlidersHorizontal size={14} />
            </Toggle>
          </div>

          {/* include / exclude glob filters */}
          {showFilters ? (
            <div className="mt-1.5 flex flex-col gap-1.5">
              <input
                value={options.includes}
                onChange={(e) => setFilter('includes', e.target.value)}
                placeholder={t('search.include.placeholder')}
                aria-label={t('search.include.label')}
                spellCheck={false}
                autoComplete="off"
                className="h-7 rounded border border-subtle bg-surface-2 px-2 text-caption font-mono text-fg-primary placeholder:text-fg-tertiary focus:outline-none focus:border-accent"
              />
              <input
                value={options.excludes}
                onChange={(e) => setFilter('excludes', e.target.value)}
                placeholder={t('search.exclude.placeholder')}
                aria-label={t('search.exclude.label')}
                spellCheck={false}
                autoComplete="off"
                className="h-7 rounded border border-subtle bg-surface-2 px-2 text-caption font-mono text-fg-primary placeholder:text-fg-tertiary focus:outline-none focus:border-accent"
              />
            </div>
          ) : null}

          {result ? (
            <div className="mt-1.5 flex items-center gap-2 px-0.5">
              <p className="flex-1 min-w-0 truncate text-caption text-fg-tertiary tabular-nums">
                {formatSearchSummary({
                  totalMatches,
                  fileCount: result.files.length,
                  truncated: result.truncated,
                })}
              </p>
              {hasResults ? (
                <>
                  <button
                    type="button"
                    onClick={() => setCollapsed(new Set())}
                    aria-label={t('search.expandAll')}
                    title={t('search.expandAll')}
                    className="shrink-0 size-5 rounded flex items-center justify-center text-fg-tertiary hover:text-fg-primary hover:bg-surface-3"
                  >
                    <ChevronsUpDown size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setCollapsed(new Set(result.files.map((f) => f.path)))
                    }
                    aria-label={t('search.collapseAll')}
                    title={t('search.collapseAll')}
                    className="shrink-0 size-5 rounded flex items-center justify-center text-fg-tertiary hover:text-fg-primary hover:bg-surface-3"
                  >
                    <ChevronsDownUp size={13} />
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* results */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {error ? (
            <p className="px-3 py-3 text-body-sm text-error break-words">{error}</p>
          ) : loading && !result ? (
            <div className="flex items-center justify-center gap-2 py-8 text-fg-tertiary">
              <Spinner size={16} /> {t('search.loading')}
            </div>
          ) : hasResults ? (
            result.files.map((file) => (
              <FileGroup
                key={file.path}
                file={file}
                collapsed={collapsed.has(file.path)}
                formatSearchMatchLineTitle={formatSearchMatchLineTitle}
                onToggle={() =>
                  setCollapsed((prev) => {
                    const next = new Set(prev);
                    if (next.has(file.path)) next.delete(file.path);
                    else next.add(file.path);
                    return next;
                  })
                }
                onOpenAt={(line, col) =>
                  void openFileInstrument(file.path, line, col)
                }
                t={t}
              />
            ))
          ) : query.trim() && !loading ? (
            <p className="px-3 py-6 text-center text-body-sm text-fg-tertiary">
              {formatSearchNoResults(query.trim())}
            </p>
          ) : (
            <p className="px-3 py-6 text-center text-caption text-fg-tertiary">
              {t('search.empty')}
            </p>
          )}
        </div>
      </div>

      {!embedded && open ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t('search.resize')}
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
              {t('search.releaseToClose')}
            </span>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}

/** One file's matches, collapsible, with a click-to-open header + match rows. */


function persistWidth(w: number): void {
  writeStoredWidth(S_WIDTH_KEY, w);
}

