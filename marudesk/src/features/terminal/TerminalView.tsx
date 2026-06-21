import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ChevronDown,
  ChevronUp,
  ClipboardPaste,
  Copy,
  Eraser,
  Folder,
  Search,
  Sparkles,
  SquareTerminal,
  TextSelect,
  X,
} from 'lucide-react';
import { randomId } from '../../../shared/id';
import type { TerminalErrorEvent } from '../../../shared/terminal-evidence';
import { useTabsStore } from '../tabs/store';
import { ContextMenu, type MenuItem } from '../../components/ContextMenu';
import { useI18n } from '../../i18n/useI18n';
import { useWebPageStore } from '../browser/store';
import { askAgent } from '../agent/store';
import {
  acquireTerminalSession,
  fitTerminalSession,
  terminalClear,
  terminalClearErrors,
  terminalClearSearch,
  terminalCopySelection,
  terminalErrorCount,
  terminalFindNext,
  terminalFindPrevious,
  terminalFocus,
  terminalHasSelection,
  terminalInfo,
  terminalOnSearchResults,
  terminalPaste,
  terminalPtyId,
  terminalPullErrors,
  terminalSelectAll,
  TERMINAL_ERRORS_EVENT,
  TERMINAL_INFO_EVENT,
  TERMINAL_OPEN_SEARCH_EVENT,
  type TerminalInfo,
} from './session';

/** Last path segment of a POSIX/Windows path, for the compact header labels. */
function basename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.userAgent);
const MOD = IS_MAC ? '⌘' : 'Ctrl';

// Model-facing fix instructions (English on purpose, like the DevTools console
// "Fix this" prompt) — the detected excerpt rides along as the attached capture.
const TERMINAL_FIX_PROMPT =
  'Fix this error from the integrated terminal. The output excerpt is attached ' +
  "with the terminal's working directory — use the read_terminal tool to see " +
  'more of the terminal output and run_diagnostics for project checks, find the ' +
  'root cause in the workspace files, fix it, then re-run the failing command ' +
  'to verify.';

/**
 * The 'terminal' tab surface. The heavy lifting lives in the session registry
 * (session.ts): this component hosts the active terminal tab's persistent xterm
 * container (re-parenting it on mount, detaching on unmount so the shell
 * survives tab switches) and layers on the chrome xterm doesn't provide — a
 * right-click context menu (copy/paste/select-all/clear/find) and a find bar
 * (Ctrl/Cmd+F). The PTY is disposed only when the tab closes.
 */
export function TerminalView({ tabId: pinnedTabId }: { tabId?: string } = {}) {
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement | null>(null);
  // In the single view the active tab IS the terminal being shown; in a grid
  // pane the tab is pinned, so a passed `tabId` wins (each pane owns its
  // session). The session registry keys by this id, so distinct panes get
  // distinct shells.
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const tabId = pinnedTabId ?? activeTabId;

  const [menu, setMenu] = useState<{ x: number; y: number; selection: boolean } | null>(
    null,
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [info, setInfo] = useState<TerminalInfo | null>(null);
  const [errorCount, setErrorCount] = useState(0);
  const [errorsOpen, setErrorsOpen] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !tabId) return;

    const session = acquireTerminalSession(tabId);
    host.appendChild(session.container);
    setInfo(terminalInfo(tabId));
    // Fit once layout has the host sized, then on every host resize.
    const raf = requestAnimationFrame(() => fitTerminalSession(tabId));
    const ro = new ResizeObserver(() => fitTerminalSession(tabId));
    ro.observe(host);
    // Ctrl/Cmd+F inside xterm bubbles up as this event (session.ts).
    const onOpenSearch = () => setSearchOpen(true);
    host.addEventListener(TERMINAL_OPEN_SEARCH_EVENT, onOpenSearch);
    // Shell/cwd resolve async; update the header when they arrive.
    const onInfo = () => setInfo(terminalInfo(tabId));
    host.addEventListener(TERMINAL_INFO_EVENT, onInfo);
    // Detected-error count pushes (terminal "Fix this") → header badge.
    setErrorCount(terminalErrorCount(tabId));
    const onErrors = () => setErrorCount(terminalErrorCount(tabId));
    host.addEventListener(TERMINAL_ERRORS_EVENT, onErrors);
    session.term.focus();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      host.removeEventListener(TERMINAL_OPEN_SEARCH_EVENT, onOpenSearch);
      host.removeEventListener(TERMINAL_INFO_EVENT, onInfo);
      host.removeEventListener(TERMINAL_ERRORS_EVENT, onErrors);
      setInfo(null);
      setErrorCount(0);
      setErrorsOpen(false);
      // Detach but keep the session alive for re-mount; disposal is the tab's
      // job (see the prune subscription in session.ts).
      if (session.container.parentElement === host) {
        host.removeChild(session.container);
      }
      // Switching tab/pane (or unmounting) closes this surface's transient UI so
      // it doesn't linger over the next terminal.
      setSearchOpen(false);
      setMenu(null);
    };
  }, [tabId]);

  const openMenu = (e: React.MouseEvent) => {
    if (!tabId) return;
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, selection: terminalHasSelection(tabId) });
  };

  const items: MenuItem[] = tabId
    ? [
        {
          label: t('terminal.menu.copy'),
          icon: <Copy size={14} />,
          shortcut: IS_MAC ? '⌘C' : 'Ctrl+Shift+C',
          disabled: !menu?.selection,
          onSelect: () => {
            terminalCopySelection(tabId);
            terminalFocus(tabId);
          },
        },
        {
          label: t('terminal.menu.paste'),
          icon: <ClipboardPaste size={14} />,
          shortcut: IS_MAC ? '⌘V' : 'Ctrl+V',
          onSelect: () => {
            terminalPaste(tabId);
            terminalFocus(tabId);
          },
        },
        { type: 'separator' },
        {
          label: t('terminal.menu.selectAll'),
          icon: <TextSelect size={14} />,
          shortcut: IS_MAC ? '⌘A' : 'Ctrl+Shift+A',
          onSelect: () => terminalSelectAll(tabId),
        },
        {
          label: t('terminal.menu.find'),
          icon: <Search size={14} />,
          shortcut: `${MOD}F`,
          onSelect: () => setSearchOpen(true),
        },
        { type: 'separator' },
        {
          label: t('terminal.menu.clear'),
          icon: <Eraser size={14} />,
          shortcut: IS_MAC ? '⌘K' : 'Ctrl+Shift+K',
          onSelect: () => {
            terminalClear(tabId);
            terminalFocus(tabId);
          },
        },
      ]
    : [];

  return (
    <div className="@container flex-1 min-h-0 min-w-0 flex flex-col bg-surface-page">
      {info ? (
        <header className="h-6 shrink-0 flex items-center gap-2 px-3 border-b border-subtle bg-surface-2 text-caption text-fg-tertiary select-none">
          <SquareTerminal size={12} className="shrink-0" aria-hidden />
          <span className="hidden @[20rem]:inline text-fg-secondary" title={t('terminal.header.shell')}>
            {basename(info.shell)}
          </span>
          <span className="hidden @[20rem]:inline text-fg-tertiary/60" aria-hidden>
            ·
          </span>
          <Folder size={12} className="shrink-0" aria-hidden />
          <span className="truncate" title={`${t('terminal.header.cwd')}: ${info.cwd}`}>
            {info.cwd}
          </span>
          {errorCount > 0 ? (
            <button
              type="button"
              onClick={() => setErrorsOpen((o) => !o)}
              title={t('terminal.errors.badgeTitle')}
              aria-label={t('terminal.errors.badgeTitle')}
              aria-expanded={errorsOpen}
              className="ml-auto flex shrink-0 items-center gap-1 rounded px-1.5 h-4 text-error hover:bg-surface-3 transition-colors duration-fast"
            >
              <AlertCircle size={11} aria-hidden />
              <span className="min-w-3.5 h-3.5 px-0.5 rounded-pill bg-error text-white text-[9px] leading-[14px] font-medium text-center tabular-nums">
                {errorCount > 9 ? '9+' : errorCount}
              </span>
            </button>
          ) : null}
        </header>
      ) : null}
      <div className="relative flex-1 min-h-0 min-w-0">
        <div
          ref={hostRef}
          onContextMenu={openMenu}
          className="absolute inset-0 bg-surface-page overflow-hidden p-1.5"
        />
        {searchOpen && tabId ? (
          <TerminalSearchBar
            tabId={tabId}
            labels={{
              placeholder: t('terminal.search.placeholder'),
              previous: t('terminal.search.previous'),
              previousTitle: t('terminal.search.previousTitle'),
              next: t('terminal.search.next'),
              nextTitle: t('terminal.search.nextTitle'),
              close: t('terminal.search.close'),
              closeTitle: t('terminal.search.closeTitle'),
            }}
            onClose={() => {
              setSearchOpen(false);
              terminalClearSearch(tabId);
              terminalFocus(tabId);
            }}
          />
        ) : null}
        {errorsOpen && tabId ? (
          <TerminalErrorsPanel tabId={tabId} onClose={() => setErrorsOpen(false)} />
        ) : null}
        {menu ? (
          <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />
        ) : null}
      </div>
    </div>
  );
}

/** First few lines of an excerpt for the compact row preview. */
function excerptPreview(excerpt: string): string {
  return excerpt.split('\n').slice(0, 3).join('\n');
}

/**
 * Compact list of the terminal's detected error events (pulled from main's
 * per-PTY ring on open). Each row shows the headline + an excerpt preview and a
 * "Fix this" action that stages a `terminal-error` capture and hands it to the
 * agent — the terminal twin of the DevTools console "Fix this" flow.
 */
function TerminalErrorsPanel({
  tabId,
  onClose,
}: {
  tabId: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [events, setEvents] = useState<TerminalErrorEvent[]>([]);

  useEffect(() => {
    let alive = true;
    void terminalPullErrors(tabId).then((evs) => {
      if (alive) setEvents(evs);
    });
    return () => {
      alive = false;
    };
  }, [tabId]);

  const fix = async (ev: TerminalErrorEvent) => {
    const ptyId = terminalPtyId(tabId);
    if (!ptyId) return;
    const info = terminalInfo(tabId);
    // Stage the error as a selected capture (already ANSI-stripped + scrubbed
    // in main), then open the chat and fire the fix loop — askAgent sends the
    // selected captures along with the prompt.
    useWebPageStore.getState().addCapture({
      kind: 'terminal-error',
      id: randomId('tcap'),
      timestamp: ev.timestamp,
      url: '',
      message: ev.message,
      excerpt: ev.excerpt,
      terminalId: ptyId,
      shell: info?.shell,
      cwd: info?.cwd,
    });
    onClose();
    await askAgent(TERMINAL_FIX_PROMPT);
  };

  const clear = async () => {
    await terminalClearErrors(tabId);
    setEvents([]);
    onClose();
    terminalFocus(tabId);
  };

  return (
    <div className="absolute right-3 top-2 z-10 flex w-full max-w-[calc(100%-1rem)] @[20rem]:w-96 flex-col rounded-md border border-default bg-surface-2 shadow-xl">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-subtle px-2 text-caption text-fg-tertiary">
        <AlertCircle size={12} className="shrink-0 text-error" aria-hidden />
        <span className="text-fg-secondary">{t('terminal.errors.title')}</span>
        <span className="flex-1" aria-hidden />
        <button
          type="button"
          onClick={() => void clear()}
          className="rounded px-1.5 py-0.5 hover:bg-surface-3 hover:text-fg-primary transition-colors duration-fast"
        >
          {t('terminal.errors.clear')}
        </button>
        <button
          type="button"
          onClick={onClose}
          title={t('terminal.errors.closeTitle')}
          aria-label={t('terminal.errors.close')}
          className="grid size-5 place-items-center rounded hover:bg-surface-3 hover:text-fg-primary"
        >
          <X size={13} />
        </button>
      </div>
      <div className="max-h-64 overflow-y-auto">
        {events.length === 0 ? (
          <div className="px-3 py-3 text-center text-caption text-fg-tertiary">
            {t('terminal.errors.empty')}
          </div>
        ) : (
          events.map((ev) => (
            <div
              key={ev.id}
              className="flex items-start gap-2 border-b border-subtle px-2 py-1.5 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <div
                  className="truncate font-mono text-caption text-error"
                  title={ev.message}
                >
                  {ev.message}
                </div>
                <div className="line-clamp-2 whitespace-pre-wrap break-all font-mono text-caption text-fg-tertiary">
                  {excerptPreview(ev.excerpt)}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void fix(ev)}
                title={t('terminal.errors.fixTitle')}
                className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded px-1.5 h-5 text-caption text-accent hover:bg-accent-subtle/40 transition-colors duration-fast"
              >
                <Sparkles size={11} aria-hidden />
                {t('terminal.errors.fix')}
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** A compact find bar overlaid top-right; drives the xterm SearchAddon. */
function TerminalSearchBar({
  tabId,
  labels,
  onClose,
}: {
  tabId: string;
  labels: {
    placeholder: string;
    previous: string;
    previousTitle: string;
    next: string;
    nextTitle: string;
    close: string;
    closeTitle: string;
  };
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ resultIndex: number; resultCount: number }>({
    resultIndex: -1,
    resultCount: 0,
  });
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Mirror the SearchAddon's match index/count for the "x / y" counter.
  useEffect(() => terminalOnSearchResults(tabId, setResults), [tabId]);

  const next = () => terminalFindNext(tabId, query);
  const prev = () => terminalFindPrevious(tabId, query);

  const btn =
    'grid size-6 place-items-center rounded text-fg-tertiary hover:bg-surface-3 hover:text-fg-primary disabled:opacity-40 disabled:hover:bg-transparent';

  return (
    <div className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded-md border border-default bg-surface-2 px-1.5 py-1 shadow-xl">
      <Search size={13} className="ml-0.5 shrink-0 text-fg-tertiary" />
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          if (e.target.value) terminalFindNext(tabId, e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) prev();
            else next();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
        placeholder={labels.placeholder}
        spellCheck={false}
        className="w-24 @[20rem]:w-40 bg-transparent text-body-sm text-fg-primary placeholder:text-fg-tertiary outline-none"
      />
      <span className="shrink-0 min-w-[3rem] px-1 text-right text-caption tabular-nums text-fg-tertiary">
        {query
          ? results.resultCount > 0
            ? `${results.resultIndex + 1}/${results.resultCount}`
            : '0/0'
          : ''}
      </span>
      <button
        type="button"
        className={btn}
        disabled={!query}
        onClick={prev}
        title={labels.previousTitle}
        aria-label={labels.previous}
      >
        <ChevronUp size={14} />
      </button>
      <button
        type="button"
        className={btn}
        disabled={!query}
        onClick={next}
        title={labels.nextTitle}
        aria-label={labels.next}
      >
        <ChevronDown size={14} />
      </button>
      <button
        type="button"
        className={btn}
        onClick={onClose}
        title={labels.closeTitle}
        aria-label={labels.close}
      >
        <X size={14} />
      </button>
    </div>
  );
}
