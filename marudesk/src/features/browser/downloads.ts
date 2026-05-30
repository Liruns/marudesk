import { create } from 'zustand';
import type { DownloadAction, DownloadEntry } from '../../../shared/downloads';

/**
 * Download-shelf store. Mirrors the main-process download list (pushed on the
 * browser:downloads event) and owns the shelf's open/closed state. The shelf
 * auto-opens when a new download appears and is dismissable; it renders at the
 * bottom of BrowserCanvas (a flex sibling, so the web view shrinks to fit —
 * a stage overlay would be hidden behind the native view).
 */

type DownloadsState = {
  downloads: DownloadEntry[];
  shelfOpen: boolean;
};

type DownloadsActions = {
  setDownloads: (list: DownloadEntry[]) => void;
  openShelf: () => void;
  closeShelf: () => void;
  act: (id: string, action: DownloadAction) => void;
  clearFinished: () => void;
};

export const useDownloadsStore = create<DownloadsState & DownloadsActions>(
  (set, get) => ({
    downloads: [],
    shelfOpen: false,

    setDownloads: (list) => {
      // A genuinely new download (id not seen before) auto-reveals the shelf;
      // pure progress updates respect a shelf the user already dismissed.
      const prevIds = new Set(get().downloads.map((d) => d.id));
      const hasNew = list.some((d) => !prevIds.has(d.id));
      set({ downloads: list, shelfOpen: get().shelfOpen || hasNew });
    },

    openShelf: () => set({ shelfOpen: true }),
    closeShelf: () => set({ shelfOpen: false }),

    act: (id, action) => {
      void window.marudesk.invoke('browser:download-action', { id, action });
    },

    clearFinished: () => {
      void window.marudesk.invoke('browser:downloads-clear');
    },
  }),
);
