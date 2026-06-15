import { useEffect, useRef, useState } from 'react';
import {
  ExternalLink,
  Globe,
  Pencil,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { useI18n } from '../../i18n/useI18n';
import { useBookmarksStore } from './bookmarks';
import { useTabsStore } from '../tabs/store';
import type { BookmarkEntry } from '../../../shared/bookmarks';
import type { HistoryEntry } from '../../../shared/history';

/**
 * The library panel: Bookmarks | History, opened from the toolbar's library
 * button. Rendered as a flex sibling of the browser stage (like the DevTools
 * dock) so the embedded WebContentsView shrinks to make room — a stage overlay
 * would be hidden behind the native view.
 *
 * Bookmarks filter client-side (the full set is mirrored in the store);
 * history queries main per keystroke (debounced) since the store there is
 * capped + searched in the main process.
 */
export function BrowserLibraryPanel() {
  const { t } = useI18n();
  const section = useBookmarksStore((s) => s.librarySection);
  const setSection = useBookmarksStore((s) => s.setLibrarySection);
  const closeLibrary = useBookmarksStore((s) => s.closeLibrary);
  const [query, setQuery] = useState('');

  return (
    <div className="w-80 shrink-0 min-h-0 flex flex-col bg-surface-1 border-l border-subtle">
      <div className="shrink-0 flex items-center gap-2 px-3 pt-3 pb-2">
        <div className="flex-1 flex items-center gap-0.5 p-0.5 rounded-md bg-surface-2">
          <SectionTab
            label={t('browser.library.tab.bookmarks')}
            active={section === 'bookmarks'}
            onClick={() => setSection('bookmarks')}
          />
          <SectionTab
            label={t('browser.library.tab.history')}
            active={section === 'history'}
            onClick={() => setSection('history')}
          />
        </div>
        <button
          type="button"
          onClick={closeLibrary}
          aria-label={t('browser.library.close')}
          title={t('browser.library.close')}
          className="shrink-0 size-6 rounded flex items-center justify-center text-fg-tertiary hover:bg-surface-2 hover:text-fg-primary transition-colors duration-fast"
        >
          <X size={14} />
        </button>
      </div>

      <div className="shrink-0 px-3 pb-2">
        <div
          className={cn(
            'h-7 rounded-md bg-surface-page border border-default flex items-center gap-2 px-2',
            'focus-within:border-strong transition-colors duration-fast',
          )}
        >
          <span className="text-fg-tertiary shrink-0" aria-hidden>
            <Search size={13} />
          </span>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t(
              section === 'bookmarks'
                ? 'browser.library.searchBookmarks'
                : 'browser.library.searchHistory',
            )}
            aria-label={t(
              section === 'bookmarks'
                ? 'browser.library.searchBookmarks'
                : 'browser.library.searchHistory',
            )}
            spellCheck={false}
            className="flex-1 min-w-0 bg-transparent text-body-sm text-fg-primary placeholder:text-fg-tertiary focus:outline-none"
          />
        </div>
      </div>

      {section === 'bookmarks' ? (
        <BookmarksSection query={query} />
      ) : (
        <HistorySection query={query} />
      )}
    </div>
  );
}

function SectionTab({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex-1 h-6 rounded text-caption font-medium transition-colors duration-fast',
        active
          ? 'bg-surface-3 text-fg-primary'
          : 'text-fg-secondary hover:text-fg-primary',
      )}
    >
      {label}
    </button>
  );
}

/* ── shared row bits ──────────────────────────────────────────────────────── */

function openEntry(url: string, inNewTab: boolean): void {
  if (inNewTab) {
    void useTabsStore.getState().newTab('web', url);
    return;
  }
  void window.marudesk.invoke('browser:navigate', url);
}

function RowAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="shrink-0 size-6 rounded flex items-center justify-center text-fg-tertiary hover:bg-surface-3 hover:text-fg-primary transition-colors duration-fast"
    >
      {children}
    </button>
  );
}

function EmptyNote({ text }: { text: string }) {
  return <p className="px-3 py-4 text-body-sm text-fg-tertiary">{text}</p>;
}

/**
 * The shared row shell for a bookmark / history entry: a click-to-open button
 * (middle-click → new tab) with an icon + title/url, and a hover-revealed action
 * cluster. Callers supply the icon and the action buttons; everything else (the
 * open behavior, layout, hover affordance) is identical between the two lists.
 */
function LibraryEntryRow({
  url,
  title,
  icon,
  actions,
}: {
  url: string;
  title: string;
  icon: React.ReactNode;
  actions: React.ReactNode;
}) {
  return (
    <div className="group relative" role="listitem">
      <button
        type="button"
        onClick={() => openEntry(url, false)}
        onAuxClick={(e) => {
          if (e.button === 1) openEntry(url, true);
        }}
        title={url}
        className="w-full flex items-center gap-2.5 px-3 py-1.5 text-left hover:bg-surface-2 transition-colors duration-fast"
      >
        <span className="shrink-0 size-4 flex items-center justify-center text-fg-tertiary">
          {icon}
        </span>
        <span className="flex-1 min-w-0">
          <span className="block truncate text-body-sm text-fg-primary">{title || url}</span>
          <span className="block truncate text-caption text-fg-tertiary">{url}</span>
        </span>
      </button>
      <div className="absolute right-2 top-1/2 -translate-y-1/2 hidden group-hover:flex group-focus-within:flex items-center gap-0.5 rounded-md bg-surface-2">
        {actions}
      </div>
    </div>
  );
}

/* ── bookmarks ────────────────────────────────────────────────────────────── */

function BookmarksSection({ query }: { query: string }) {
  const { t } = useI18n();
  const bookmarks = useBookmarksStore((s) => s.bookmarks);
  const q = query.trim().toLowerCase();
  const visible = q
    ? bookmarks.filter(
        (b) => b.title.toLowerCase().includes(q) || b.url.toLowerCase().includes(q),
      )
    : bookmarks;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto pb-2" role="list">
      {visible.length === 0 ? (
        <EmptyNote
          text={t(
            bookmarks.length === 0
              ? 'browser.library.bookmarksEmpty'
              : 'browser.library.noMatches',
          )}
        />
      ) : (
        visible.map((b) => <BookmarkRow key={b.id} entry={b} />)
      )}
    </div>
  );
}

function BookmarkRow({ entry }: { entry: BookmarkEntry }) {
  const { t } = useI18n();
  const removeBookmark = useBookmarksStore((s) => s.removeBookmark);
  const renameBookmark = useBookmarksStore((s) => s.renameBookmark);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commitRename = (): void => {
    setEditing(false);
    const title = draft.trim();
    if (title && title !== entry.title) void renameBookmark(entry.id, title);
    else setDraft(entry.title);
  };

  if (editing) {
    return (
      <div className="px-3 py-1" role="listitem">
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename();
            if (e.key === 'Escape') {
              setDraft(entry.title);
              setEditing(false);
            }
          }}
          aria-label={t('browser.library.renameAria')}
          className="w-full h-7 rounded-md bg-surface-page border border-strong px-2 text-body-sm text-fg-primary focus:outline-none"
        />
      </div>
    );
  }

  return (
    <LibraryEntryRow
      url={entry.url}
      title={entry.title}
      icon={
        entry.faviconUrl ? (
          <img src={entry.faviconUrl} alt="" className="size-4 rounded-sm" />
        ) : (
          <Globe size={14} />
        )
      }
      actions={
        <>
          <RowAction
            label={t('browser.library.openInNewTab')}
            onClick={() => openEntry(entry.url, true)}
          >
            <ExternalLink size={13} />
          </RowAction>
          <RowAction label={t('browser.library.rename')} onClick={() => setEditing(true)}>
            <Pencil size={13} />
          </RowAction>
          <RowAction
            label={t('browser.library.delete')}
            onClick={() => void removeBookmark(entry.id)}
          >
            <Trash2 size={13} />
          </RowAction>
        </>
      }
    />
  );
}

/* ── history ──────────────────────────────────────────────────────────────── */

function HistorySection({ query }: { query: string }) {
  const { locale, t } = useI18n();
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);

  // Query main per keystroke, debounced; drop a stale response if the query
  // moved on while the invoke was in flight.
  useEffect(() => {
    let stale = false;
    const timer = setTimeout(() => {
      void window.marudesk
        .invoke('history:list', { query })
        .then((list) => {
          if (!stale) setEntries(list);
        })
        .catch(() => undefined);
    }, 150);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [query]);

  const deleteEntry = (url: string): void => {
    void window.marudesk.invoke('history:delete', { url }).catch(() => undefined);
    setEntries((cur) => (cur ? cur.filter((e) => e.url !== url) : cur));
  };

  const clearAll = (): void => {
    setConfirmingClear(false);
    void window.marudesk.invoke('history:clear').catch(() => undefined);
    setEntries([]);
  };

  const groups = groupByDay(entries ?? [], locale, {
    today: t('browser.library.today'),
    yesterday: t('browser.library.yesterday'),
  });

  return (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto pb-2">
        {entries !== null && entries.length === 0 ? (
          <EmptyNote
            text={t(
              query.trim()
                ? 'browser.library.noMatches'
                : 'browser.library.historyEmpty',
            )}
          />
        ) : (
          groups.map((group) => (
            <div key={group.label} role="list" aria-label={group.label}>
              <p className="px-3 pt-3 pb-1 text-caption font-medium text-fg-secondary">
                {group.label}
              </p>
              {group.entries.map((e) => (
                <HistoryRow key={e.url} entry={e} onDelete={deleteEntry} />
              ))}
            </div>
          ))
        )}
      </div>
      <div className="shrink-0 px-3 py-2 border-t border-subtle">
        {confirmingClear ? (
          <div className="flex items-center gap-2">
            <span className="flex-1 min-w-0 truncate text-caption text-fg-secondary">
              {t('browser.library.clearConfirm')}
            </span>
            <button
              type="button"
              onClick={clearAll}
              className="shrink-0 text-caption font-medium text-error px-2 py-1 rounded hover:bg-surface-2 transition-colors duration-fast"
            >
              {t('browser.library.clearConfirmAction')}
            </button>
            <button
              type="button"
              onClick={() => setConfirmingClear(false)}
              className="shrink-0 text-caption text-fg-secondary px-2 py-1 rounded hover:bg-surface-2 hover:text-fg-primary transition-colors duration-fast"
            >
              {t('browser.library.clearCancel')}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmingClear(true)}
            disabled={entries === null || entries.length === 0}
            className={cn(
              'text-caption px-2 py-1 rounded transition-colors duration-fast',
              entries === null || entries.length === 0
                ? 'text-fg-disabled cursor-not-allowed'
                : 'text-fg-secondary hover:bg-surface-2 hover:text-fg-primary',
            )}
          >
            {t('browser.library.clearHistory')}
          </button>
        )}
      </div>
    </>
  );
}

function HistoryRow({
  entry,
  onDelete,
}: {
  entry: HistoryEntry;
  onDelete: (url: string) => void;
}) {
  const { t } = useI18n();
  return (
    <LibraryEntryRow
      url={entry.url}
      title={entry.title}
      icon={<Globe size={14} />}
      actions={
        <>
          <RowAction
            label={t('browser.library.openInNewTab')}
            onClick={() => openEntry(entry.url, true)}
          >
            <ExternalLink size={13} />
          </RowAction>
          <RowAction
            label={t('browser.library.removeFromHistory')}
            onClick={() => onDelete(entry.url)}
          >
            <Trash2 size={13} />
          </RowAction>
        </>
      }
    />
  );
}

/**
 * Group recency-sorted history entries into day buckets — Today / Yesterday /
 * a locale-formatted date. Entries arrive most-recent-first, so one
 * sequential pass keeps groups in order.
 */
function groupByDay(
  entries: HistoryEntry[],
  locale: string,
  labels: { today: string; yesterday: string },
): { label: string; entries: HistoryEntry[] }[] {
  const startOfDay = (ms: number): number => {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const todayStart = startOfDay(Date.now());
  const labelFor = (ms: number): string => {
    const dayStart = startOfDay(ms);
    const diffDays = Math.round((todayStart - dayStart) / 86_400_000);
    if (diffDays <= 0) return labels.today;
    if (diffDays === 1) return labels.yesterday;
    return new Date(ms).toLocaleDateString(locale, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  const groups: { label: string; entries: HistoryEntry[] }[] = [];
  for (const entry of entries) {
    const label = labelFor(entry.lastVisit);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.entries.push(entry);
    else groups.push({ label, entries: [entry] });
  }
  return groups;
}
