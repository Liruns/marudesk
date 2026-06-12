import { Globe, Trash2 } from 'lucide-react';
import type { Bookmark } from '../../../shared/bookmarks';
import { stripUrlPrefix } from '../../../shared/history';
import { cn } from '../../lib/cn';
import { useBookmarksStore } from './bookmarks';
import { useBrowserStrings } from './browserStrings';

/**
 * Bookmarks panel — a chrome row below the toolbar (a flex sibling, like the
 * find bar), because the WebContentsView paints above the React DOM so a
 * floating dropdown over the stage would be occluded. Click a row to open it
 * in the active tab; the delete action reveals on hover.
 */
export function BookmarksPanel() {
  const { t } = useBrowserStrings();
  const bookmarks = useBookmarksStore((s) => s.bookmarks);
  const remove = useBookmarksStore((s) => s.remove);
  const closePanel = useBookmarksStore((s) => s.closePanel);

  const open = (url: string): void => {
    void window.marudesk.invoke('browser:navigate', url);
    closePanel();
  };

  return (
    <div
      className="shrink-0 max-h-64 overflow-y-auto bg-surface-1 border-b border-subtle py-1"
      aria-label={t('browser.bookmarks.title')}
    >
      {bookmarks.length === 0 ? (
        <p className="px-3.5 py-2 text-body-sm text-fg-tertiary">
          {t('browser.bookmarks.empty')}
        </p>
      ) : (
        bookmarks.map((b) => (
          <div
            key={b.id}
            className="group flex items-center gap-1 pr-2 hover:bg-surface-2 transition-colors duration-fast"
          >
            <button
              type="button"
              onClick={() => open(b.url)}
              title={b.url}
              className="min-w-0 flex-1 flex items-center gap-2.5 px-3.5 py-1.5 text-left"
            >
              <BookmarkFavicon bookmark={b} />
              <span className="shrink-0 max-w-[40%] truncate text-body-sm text-fg-primary">
                {b.title || stripUrlPrefix(b.url)}
              </span>
              <span className="min-w-0 flex-1 truncate text-caption text-fg-tertiary">
                {stripUrlPrefix(b.url)}
              </span>
              {b.folder ? (
                <span className="shrink-0 px-2 py-px rounded-pill bg-surface-3 text-caption text-fg-secondary">
                  {b.folder}
                </span>
              ) : null}
            </button>
            <button
              type="button"
              aria-label={t('browser.bookmarks.delete')}
              title={t('browser.bookmarks.delete')}
              onClick={() => void remove(b.id)}
              className={cn(
                'size-6 rounded flex items-center justify-center shrink-0',
                'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
                'text-fg-secondary hover:bg-surface-3 hover:text-fg-primary',
                'transition-colors duration-fast',
              )}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))
      )}
    </div>
  );
}

function BookmarkFavicon({ bookmark }: { readonly bookmark: Bookmark }) {
  if (bookmark.faviconUrl) {
    return (
      <img
        src={bookmark.faviconUrl}
        alt=""
        className="size-3.5 shrink-0 rounded-sm"
        draggable={false}
      />
    );
  }
  return <Globe size={14} className="shrink-0 text-fg-tertiary" aria-hidden />;
}
