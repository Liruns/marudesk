/**
 * Bookmarks contract. Entries are persisted in main
 * (electron/browser/bookmarks.ts) and mirrored to the renderer's library panel
 * via the `browser:bookmarks` push + the `bookmarks:*` invokes. A plain
 * serializable record — no live handles.
 */
export type BookmarkEntry = {
  /** Stable id (assigned by main on add); rename/remove address it. */
  id: string;
  url: string;
  title: string;
  /**
   * The page favicon as a self-contained `data:` URL (same form as
   * NavState.favicon, see electron/browser/favicon.ts), or undefined when the
   * page had none when bookmarked. Inlined so the renderer can show it under
   * its strict `img-src 'self' data: blob:` CSP.
   */
  faviconUrl?: string;
  /** Epoch ms when the bookmark was created. */
  createdAt: number;
};

/** Renderer input for `bookmarks:add` — main assigns id/createdAt. */
export type BookmarkInput = {
  url: string;
  title: string;
  faviconUrl?: string;
};
