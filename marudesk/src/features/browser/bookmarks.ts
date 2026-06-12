import { create } from 'zustand';
import type { Bookmark, BookmarkInput } from '../../../shared/bookmarks';

/**
 * Renderer mirror of the main-process bookmark store (electron/bookmarks.ts).
 * Main owns the persisted list; every mutation round-trips and re-syncs the
 * local copy, so the star toggle and the panel can't drift from disk. `load`
 * is lazy and idempotent — the first consumer triggers the initial fetch.
 */

type BookmarksState = {
  bookmarks: Bookmark[];
  loaded: boolean;
  /** The toolbar bookmarks panel (a chrome row below the toolbar). */
  panelOpen: boolean;
};

type BookmarksActions = {
  load: () => Promise<void>;
  /** Address-bar star: bookmark the current page, or un-bookmark it. */
  toggle: (input: BookmarkInput) => Promise<void>;
  remove: (id: string) => Promise<void>;
  togglePanel: () => void;
  closePanel: () => void;
};

export const useBookmarksStore = create<BookmarksState & BookmarksActions>(
  (set, get) => ({
    bookmarks: [],
    loaded: false,
    panelOpen: false,

    load: async () => {
      if (get().loaded) return;
      set({ loaded: true });
      try {
        const bookmarks = await window.marudesk.invoke('bookmarks:list');
        set({ bookmarks });
      } catch {
        // Listing failed (e.g. early startup) — retry on the next load call.
        set({ loaded: false });
      }
    },

    toggle: async (input) => {
      const result = await window.marudesk.invoke('bookmarks:toggle', input);
      set((s) => ({
        bookmarks: result
          ? [result, ...s.bookmarks.filter((b) => b.id !== result.id)]
          : s.bookmarks.filter((b) => b.url !== input.url),
      }));
    },

    remove: async (id) => {
      await window.marudesk.invoke('bookmarks:remove', { id });
      set((s) => ({ bookmarks: s.bookmarks.filter((b) => b.id !== id) }));
    },

    togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
    closePanel: () => set({ panelOpen: false }),
  }),
);

/** Whether `url` is bookmarked — drives the star's filled state. */
export function selectIsBookmarked(url: string) {
  return (s: BookmarksState): boolean =>
    url.length > 0 && s.bookmarks.some((b) => b.url === url);
}
