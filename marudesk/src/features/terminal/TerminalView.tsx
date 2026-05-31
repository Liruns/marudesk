import { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  ClipboardPaste,
  Copy,
  Eraser,
  Search,
  TextSelect,
  X,
} from 'lucide-react';
import { useTabsStore } from '../tabs/store';
import { ContextMenu, type MenuItem } from '../../components/ContextMenu';
import {
  acquireTerminalSession,
  fitTerminalSession,
  terminalClear,
  terminalClearSearch,
  terminalCopySelection,
  terminalFindNext,
  terminalFindPrevious,
  terminalFocus,
  terminalHasSelection,
  terminalPaste,
  terminalSelectAll,
  TERMINAL_OPEN_SEARCH_EVENT,
} from './session';

const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.userAgent);
const MOD = IS_MAC ? '⌘' : 'Ctrl';

/**
 * The 'terminal' tab surface. The heavy lifting lives in the session registry
 * (session.ts): this component hosts the active terminal tab's persistent xterm
 * container (re-parenting it on mount, detaching on unmount so the shell
 * survives tab switches) and layers on the chrome xterm doesn't provide — a
 * right-click context menu (copy/paste/select-all/clear/find) and a find bar
 * (Ctrl/Cmd+F). The PTY is disposed only when the tab closes.
 */
export function TerminalView({ tabId: pinnedTabId }: { tabId?: string } = {}) {
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

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !tabId) return;

    const session = acquireTerminalSession(tabId);
    host.appendChild(session.container);
    // Fit once layout has the host sized, then on every host resize.
    const raf = requestAnimationFrame(() => fitTerminalSession(tabId));
    const ro = new ResizeObserver(() => fitTerminalSession(tabId));
    ro.observe(host);
    // Ctrl/Cmd+F inside xterm bubbles up as this event (session.ts).
    const onOpenSearch = () => setSearchOpen(true);
    host.addEventListener(TERMINAL_OPEN_SEARCH_EVENT, onOpenSearch);
    session.term.focus();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      host.removeEventListener(TERMINAL_OPEN_SEARCH_EVENT, onOpenSearch);
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
          label: 'Copy',
          icon: <Copy size={14} />,
          shortcut: IS_MAC ? '⌘C' : 'Ctrl+Shift+C',
          disabled: !menu?.selection,
          onSelect: () => {
            terminalCopySelection(tabId);
            terminalFocus(tabId);
          },
        },
        {
          label: 'Paste',
          icon: <ClipboardPaste size={14} />,
          shortcut: IS_MAC ? '⌘V' : 'Ctrl+V',
          onSelect: () => {
            terminalPaste(tabId);
            terminalFocus(tabId);
          },
        },
        { type: 'separator' },
        {
          label: 'Select All',
          icon: <TextSelect size={14} />,
          shortcut: IS_MAC ? '⌘A' : 'Ctrl+Shift+A',
          onSelect: () => terminalSelectAll(tabId),
        },
        {
          label: 'Find…',
          icon: <Search size={14} />,
          shortcut: `${MOD}F`,
          onSelect: () => setSearchOpen(true),
        },
        { type: 'separator' },
        {
          label: 'Clear',
          icon: <Eraser size={14} />,
          onSelect: () => {
            terminalClear(tabId);
            terminalFocus(tabId);
          },
        },
      ]
    : [];

  return (
    <div className="relative flex-1 min-h-0 min-w-0">
      <div
        ref={hostRef}
        onContextMenu={openMenu}
        className="absolute inset-0 bg-surface-page overflow-hidden p-1.5"
      />
      {searchOpen && tabId ? (
        <TerminalSearchBar
          tabId={tabId}
          onClose={() => {
            setSearchOpen(false);
            terminalClearSearch(tabId);
            terminalFocus(tabId);
          }}
        />
      ) : null}
      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />
      ) : null}
    </div>
  );
}

/** A compact find bar overlaid top-right; drives the xterm SearchAddon. */
function TerminalSearchBar({
  tabId,
  onClose,
}: {
  tabId: string;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

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
        placeholder="Find"
        spellCheck={false}
        className="w-40 bg-transparent text-body-sm text-fg-primary placeholder:text-fg-tertiary outline-none"
      />
      <button
        type="button"
        className={btn}
        disabled={!query}
        onClick={prev}
        title="Previous (Shift+Enter)"
        aria-label="Find previous"
      >
        <ChevronUp size={14} />
      </button>
      <button
        type="button"
        className={btn}
        disabled={!query}
        onClick={next}
        title="Next (Enter)"
        aria-label="Find next"
      >
        <ChevronDown size={14} />
      </button>
      <button
        type="button"
        className={btn}
        onClick={onClose}
        title="Close (Esc)"
        aria-label="Close find"
      >
        <X size={14} />
      </button>
    </div>
  );
}
