/**
 * Bookmarks contract. A flat list (optional `folder` string, no nested tree),
 * persisted in main under userData (electron/bookmarks.ts) and consumed by the
 * toolbar star toggle, the bookmarks panel, and the address-bar suggestions.
 * Plain serializable records — no live handles.
 */
export type Bookmark = {
  id: string;
  url: string;
  title: string;
  /**
   * The page favicon as a self-contained `data:` URL (captured from NavState
   * when the bookmark is created), or absent when the page had none. Inlined —
   * like NavState.favicon — so the renderer can show it under its strict
   * `img-src 'self' data: blob:` CSP.
   */
  faviconUrl?: string;
  /** Epoch ms when the bookmark was created. */
  createdAt: number;
  /** Optional flat folder label (no nesting). */
  folder?: string;
};

/** Renderer→main payload for add/toggle — main mints `id`/`createdAt`. */
export type BookmarkInput = {
  url: string;
  title: string;
  faviconUrl?: string;
  folder?: string;
};
