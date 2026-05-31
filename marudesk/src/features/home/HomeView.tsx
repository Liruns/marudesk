import { useState, type FormEvent, type ReactNode } from 'react';
import { Code2, Globe, SquareTerminal } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useTabsStore } from '../tabs/store';
import { useGridStore } from '../tabs/grid';
import type { TabKind } from '../../../shared/browser';

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
  const [query, setQuery] = useState('');

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

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const value = query.trim();
    if (!value) return;
    open('web', value);
    setQuery('');
  };

  return (
    <div className="flex-1 min-w-0 overflow-y-auto bg-surface-page">
      <div className="min-h-full flex flex-col items-center justify-center px-8 py-16 gap-10">
        <div className="flex flex-col items-center gap-3">
          <div className="size-12 rounded-2xl bg-accent-subtle ring-1 ring-accent/25 flex items-center justify-center">
            <span className="size-4 rounded-pill bg-accent" aria-hidden />
          </div>
          <div className="flex flex-col items-center gap-1">
            <h1 className="text-title text-fg-primary tracking-tight">marudesk</h1>
            <p className="text-body-sm text-fg-tertiary">Browser-native AI IDE</p>
          </div>
        </div>

        <form onSubmit={onSubmit} className="w-full max-w-xl" role="search">
          <div
            className={cn(
              'h-11 w-full rounded-pill bg-surface-1 border flex items-center pl-4 pr-2 gap-2',
              'border-default focus-within:border-accent transition-colors duration-fast',
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
              onChange={(e) => setQuery(e.target.value)}
              className={cn(
                'flex-1 min-w-0 bg-transparent text-body-sm text-fg-primary',
                'placeholder:text-fg-tertiary focus:outline-none',
              )}
              aria-label="Search or enter a URL"
            />
          </div>
        </form>

        <div className="w-full max-w-xl grid grid-cols-1 sm:grid-cols-3 gap-3">
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

        <p className="text-caption text-fg-tertiary flex items-center gap-1.5">
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
        'bg-surface-1 border border-subtle',
        'hover:border-accent/60 hover:bg-surface-2 hover:-translate-y-0.5 hover:shadow-lg',
        'transition duration-fast',
      )}
    >
      <span className="flex size-9 items-center justify-center rounded-lg bg-surface-2 text-fg-secondary group-hover:bg-accent-subtle group-hover:text-accent transition-colors duration-fast">
        {icon}
      </span>
      <span className="text-body-sm text-fg-primary font-medium">{label}</span>
      <span className="text-caption text-fg-tertiary">{hint}</span>
    </button>
  );
}
