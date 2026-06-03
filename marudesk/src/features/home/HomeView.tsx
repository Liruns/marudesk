import {
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { Code2, Folder, Globe, History, Sparkles, SquareTerminal } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useTabsStore } from '../tabs/store';
import { useGridStore } from '../tabs/grid';
import { useWorkspaceStore } from '../workspace/store';
import type { TabKind } from '../../../shared/browser';
import type { HistoryEntry } from '../../../shared/history';
import logoUrl from '../../assets/logo-mark.png';

/**
 * The 'home' tab kind — marudesk's New Tab page and the first feature-tab: a
 * tab whose content is a React surface rather than a WebContentsView. It proves
 * the "tab = container of a kind" model end to end (creation, tab-strip glyph,
 * activation hiding the browser view) and doubles as the launcher for the other
 * kinds.
 *
 * Layout follows Chrome's NTP / Arc's start view: a centered field that opens a
 * web tab, plus a launcher grid for the other tab kinds.
 *
 * `tabId` is this home tab's id (supplied in grid mode by the registry; in the
 * single view it falls back to the active tab, which IS this home tab). Opening
 * a kind / entering a URL **converts this tab in place** rather than spawning a
 * second tab — matching the New Tab behavior every browser has.
 */
export function HomeView({ tabId }: { tabId?: string }) {
  const replaceTab = useTabsStore((s) => s.replaceTab);
  const newTab = useTabsStore((s) => s.newTab);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const recents = useWorkspaceStore((s) => s.recents);
  const openRecent = useWorkspaceStore((s) => s.openRecent);
  const [query, setQuery] = useState('');
  // Address-bar history suggestions (home is a React surface, so the dropdown
  // isn't occluded by a WebContentsView the way the browser toolbar's would be).
  const [suggestions, setSuggestions] = useState<HistoryEntry[]>([]);
  const [highlight, setHighlight] = useState(-1);
  const [recentFilter, setRecentFilter] = useState('');
  // Latest typed value, so an out-of-order history:query result is discarded.
  const latestQuery = useRef('');

  // Convert this very tab; fall back to a new tab only if we somehow can't
  // resolve our own id (keeps the launcher functional rather than dead). When
  // this home tab is a tiled grid pane, repoint that pane at the replacement id
  // (it gets a new id) so the conversion shows in-pane instead of orphaning it.
  const open = (kind: TabKind, url?: string) => {
    const target = tabId ?? activeTabId;
    if (!target) {
      void newTab(kind, url);
      return;
    }
    void replaceTab(target, kind, url).then((newId) => {
      if (newId) useGridStore.getState().remap(target, newId);
    });
  };

  const onQueryChange = (value: string) => {
    setQuery(value);
    setHighlight(-1);
    latestQuery.current = value;
    const q = value.trim();
    if (!q) {
      setSuggestions([]);
      return;
    }
    void window.marudesk
      .invoke('history:query', q)
      .then((entries) => {
        // Drop a stale result if the user kept typing past this query.
        if (latestQuery.current !== value) return;
        setSuggestions(entries.slice(0, 6));
      })
      .catch(() => setSuggestions([]));
  };

  const go = (value: string) => {
    const v = value.trim();
    if (!v) return;
    open('web', v);
    setQuery('');
    setSuggestions([]);
    setHighlight(-1);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (highlight >= 0 && suggestions[highlight]) go(suggestions[highlight].url);
    else go(query);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (suggestions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => (h + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => (h <= 0 ? suggestions.length - 1 : h - 1));
    } else if (e.key === 'Escape') {
      setSuggestions([]);
      setHighlight(-1);
    }
  };

  const filteredRecents = useMemo(() => {
    const q = recentFilter.trim().toLowerCase();
    if (!q) return recents;
    return recents.filter(
      (r) => r.name.toLowerCase().includes(q) || r.root.toLowerCase().includes(q),
    );
  }, [recents, recentFilter]);

  return (
    <div className="flex-1 min-w-0 overflow-y-auto bg-surface-page bg-vignette">
      <div className="min-h-full flex flex-col items-center justify-center px-8 py-16 gap-10">
        <div className="flex flex-col items-center gap-4 animate-fade-rise">
          <div className="relative">
            {/* The single sanctioned chromatic bloom — brand light behind the
                mark. Decorative, so it's hidden from a11y and ignores pointers. */}
            <div
              aria-hidden
              className="pointer-events-none absolute -inset-6 -z-10 bg-accent-glow"
            />
            <img src={logoUrl} alt="" aria-hidden draggable={false} className="size-16 select-none" />
          </div>
          <div className="flex flex-col items-center gap-1.5">
            <h1 className="text-hero font-display text-fg-primary">marudesk</h1>
            <p className="text-body-sm text-fg-tertiary">Browser-native AI IDE</p>
          </div>
        </div>

        <form
          onSubmit={onSubmit}
          className="relative w-full max-w-xl animate-fade-rise [animation-delay:60ms]"
          role="search"
        >
          <div
            className={cn(
              'h-11 w-full rounded-pill bg-surface-1 border flex items-center pl-4 pr-2 gap-2',
              'border-default focus-within:border-accent focus-within:shadow-focus-accent',
              'transition-[border-color,box-shadow] duration-fast',
            )}
          >
            <Globe size={16} className="text-fg-tertiary shrink-0" aria-hidden />
            <input
              type="text"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              placeholder="Search or enter a URL"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              onKeyDown={onKeyDown}
              onBlur={() => window.setTimeout(() => setSuggestions([]), 120)}
              className={cn(
                'flex-1 min-w-0 bg-transparent text-body-sm text-fg-primary',
                'placeholder:text-fg-tertiary focus:outline-none',
              )}
              aria-label="Search or enter a URL"
            />
          </div>
          {suggestions.length > 0 ? (
            <ul
              className="absolute left-0 right-0 top-12 z-20 overflow-hidden rounded-xl border border-default bg-surface-1 shadow-card py-1"
              role="listbox"
            >
              {suggestions.map((s, i) => (
                <li key={s.url} role="option" aria-selected={i === highlight}>
                  <button
                    type="button"
                    // onMouseDown (not onClick) so it fires before the input's
                    // onBlur clears the list.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      go(s.url);
                    }}
                    onMouseEnter={() => setHighlight(i)}
                    className={cn(
                      'flex w-full items-center gap-2.5 px-3 py-1.5 text-left',
                      i === highlight ? 'bg-surface-2' : 'hover:bg-surface-2',
                    )}
                  >
                    <History size={14} className="shrink-0 text-fg-tertiary" aria-hidden />
                    {s.title ? (
                      <span className="shrink-0 max-w-[40%] truncate text-body-sm text-fg-secondary">
                        {s.title}
                      </span>
                    ) : null}
                    <span className="min-w-0 flex-1 truncate text-caption text-fg-tertiary">
                      {s.url}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </form>

        <div className="w-full max-w-xl grid grid-cols-1 sm:grid-cols-2 gap-3 animate-fade-rise [animation-delay:120ms]">
          <LauncherCard
            label="AI Chat"
            hint="Agent that sees the running app"
            icon={<Sparkles size={18} />}
            onOpen={() => open('agent')}
          />
          <LauncherCard
            label="Browser tab"
            hint="Open a blank page"
            icon={<Globe size={18} />}
            onOpen={() => open('web')}
          />
          <LauncherCard
            label="Terminal"
            hint="Shell in a tab"
            icon={<SquareTerminal size={18} />}
            onOpen={() => open('terminal')}
          />
          <LauncherCard
            label="Code editor"
            hint="Edit files in a tab"
            icon={<Code2 size={18} />}
            onOpen={() => open('editor')}
          />
        </div>

        {recents.length > 0 ? (
          <div className="w-full max-w-xl flex flex-col gap-0.5 animate-fade-rise [animation-delay:180ms]">
            <div className="flex items-center gap-2 px-1 pb-1">
              <p className="text-caption uppercase tracking-wider text-fg-tertiary">
                Recent
              </p>
              {recents.length > 5 ? (
                <input
                  value={recentFilter}
                  onChange={(e) => setRecentFilter(e.target.value)}
                  placeholder="Filter…"
                  spellCheck={false}
                  aria-label="Filter recent workspaces"
                  className="ml-auto h-6 w-32 rounded bg-surface-1 border border-subtle px-2 text-caption text-fg-primary placeholder:text-fg-tertiary focus:outline-none focus:border-accent"
                />
              ) : null}
            </div>
            {filteredRecents.length === 0 ? (
              <p className="px-3 py-2 text-caption text-fg-tertiary">No matches</p>
            ) : null}
            {filteredRecents.map((r) => (
              <button
                key={r.root}
                type="button"
                onClick={() => void openRecent(r.root)}
                className={cn(
                  'group flex items-center gap-2.5 rounded-lg px-3 py-2 text-left',
                  'hover:bg-surface-1 transition-colors duration-fast',
                )}
              >
                <Folder
                  size={15}
                  className="shrink-0 text-fg-tertiary group-hover:text-accent transition-colors duration-fast"
                />
                <span className="shrink-0 text-body-sm text-fg-secondary group-hover:text-fg-primary">
                  {r.name}
                </span>
                <span
                  className="min-w-0 flex-1 truncate text-caption text-fg-tertiary"
                  title={r.root}
                >
                  {r.root}
                </span>
              </button>
            ))}
          </div>
        ) : null}

        <p className="text-caption text-fg-tertiary flex items-center gap-1.5 animate-fade-rise [animation-delay:240ms]">
          <kbd className="px-1.5 py-0.5 rounded bg-surface-2 border border-subtle text-fg-secondary">
            Ctrl
          </kbd>
          <span aria-hidden>+</span>
          <kbd className="px-1.5 py-0.5 rounded bg-surface-2 border border-subtle text-fg-secondary">
            T
          </kbd>
          <span>opens a new tab</span>
        </p>
      </div>
    </div>
  );
}

function LauncherCard({
  label,
  hint,
  icon,
  onOpen,
}: {
  label: string;
  hint: string;
  icon: ReactNode;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'group flex flex-col items-start gap-2.5 p-4 rounded-xl text-left',
        'bg-surface-1 bg-surface-gradient border border-subtle shadow-highlight',
        'hover:border-accent/60 hover:bg-surface-2 hover:-translate-y-0.5 hover:shadow-card',
        'active:translate-y-0 active:scale-[0.99] active:shadow-highlight',
        'transition duration-fast',
      )}
    >
      <span className="flex size-9 items-center justify-center rounded-lg bg-surface-2 shadow-highlight text-fg-secondary group-hover:bg-accent-subtle group-hover:text-accent transition-colors duration-fast">
        {icon}
      </span>
      <span className="text-body-sm text-fg-primary font-medium">{label}</span>
      <span className="text-caption text-fg-tertiary">{hint}</span>
    </button>
  );
}
