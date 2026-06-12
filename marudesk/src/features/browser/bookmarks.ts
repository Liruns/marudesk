import { create } from 'zustand';
import type { BookmarkEntry } from '../../../shared/bookmarks';

/**
 * Bookmarks + library-panel store. Mirrors the main-process bookmark list
 * (pushed on the browser:bookmarks event, pulled once on mount — the downloads
 * pattern) and owns the library panel's open/section state. The panel renders
 * as a flex sibling of the browser stage in BrowserCanvas (like the DevTools
 * dock) — a stage overlay would be hidden behind the native WebContentsView.
 */

export type LibrarySection = 'bookmarks' | 'history';

type BookmarksState = {
  bookmarks: BookmarkEntry[];
  libraryOpen: boolean;
  librarySection: LibrarySection;
};

type BookmarksActions = {
  setBookmarks: (list: BookmarkEntry[]) => void;
  openLibrary: (section?: LibrarySection) => void;
  closeLibrary: () => void;
  toggleLibrary: () => void;
  setLibrarySection: (section: LibrarySection) => void;
  /**
   * Star-button toggle for the page at `url`: removes the existing bookmark or
   * adds one from the active tab's title/favicon. The invoke resolves the
   * fresh list, adopted immediately (the push covers other listeners).
   */
  toggleBookmark: (input: { url: string; title: string; faviconUrl?: string }) => Promise<void>;
  removeBookmark: (id: string) => Promise<void>;
  renameBookmark: (id: string, title: string) => Promise<void>;
};

/** The bookmark for `url`, or undefined — drives the star button's fill. */
export function findBookmark(
  bookmarks: readonly BookmarkEntry[],
  url: string,
): BookmarkEntry | undefined {
  return url ? bookmarks.find((b) => b.url === url) : undefined;
}

export const useBookmarksStore = create<BookmarksState & BookmarksActions>(
  (set, get) => ({
    bookmarks: [],
    libraryOpen: false,
    librarySection: 'bookmarks',

    setBookmarks: (bookmarks) => set({ bookmarks }),

    openLibrary: (section) =>
      set((s) => ({
        libraryOpen: true,
        librarySection: section ?? s.librarySection,
      })),
    closeLibrary: () => set({ libraryOpen: false }),
    toggleLibrary: () => set((s) => ({ libraryOpen: !s.libraryOpen })),
    setLibrarySection: (librarySection) => set({ librarySection }),

    toggleBookmark: async ({ url, title, faviconUrl }) => {
      if (!url) return;
      const existing = findBookmark(get().bookmarks, url);
      const list = existing
        ? await window.marudesk.invoke('bookmarks:remove', { id: existing.id })
        : await window.marudesk.invoke('bookmarks:add', {
            url,
            title: title || url,
            faviconUrl: faviconUrl || undefined,
          });
      set({ bookmarks: list });
    },

    removeBookmark: async (id) => {
      const list = await window.marudesk.invoke('bookmarks:remove', { id });
      set({ bookmarks: list });
    },

    renameBookmark: async (id, title) => {
      const list = await window.marudesk.invoke('bookmarks:update', { id, title });
      set({ bookmarks: list });
    },
  }),
);
