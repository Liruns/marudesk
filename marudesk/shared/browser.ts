/**
 * Snapshot of the embedded browser's navigation state. Pushed from main on
 * any change so the renderer can keep its toolbar in sync with the
 * WebContentsView (which renders above the React DOM and can't be inspected
 * from the renderer).
 */
export type NavState = {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  isSecure: boolean;
  /**
   * The active favicon as a self-contained `data:` URL, or '' when the page has
   * none yet. Main fetches the page's declared icon and inlines it (see
   * electron/browser/favicon.ts) precisely so the renderer can render it under
   * its strict `img-src 'self' data: blob:` CSP — a raw external favicon URL
   * would be blocked.
   */
  favicon: string;
  /**
   * The web tab's renderer process died (crash / OOM / killed) and has not been
   * reloaded yet. Main hides the dead view via the layout engine so the React
   * stage can paint a recovery card; cleared the moment a reload begins.
   */
  crashed: boolean;
  /** Page zoom factor (1 = 100%). Per-tab; the toolbar shows a reset chip ≠ 1. */
  zoomFactor: number;
};

/**
 * Feature tab kinds — every kind whose content is a React surface in the stage
 * (i.e. everything that is NOT the embedded web view). Declared once as an array
 * so the renderer's `TabKind` union *and* the main-process validator
 * (`isTabKind`) / title table (`FEATURE_TITLES`) all derive from this single
 * list and can't drift: add a kind here and it widens everywhere at once.
 */
export const FEATURE_KINDS = ['home', 'terminal', 'editor', 'settings', 'agent'] as const;

/** A non-web tab kind (one of {@link FEATURE_KINDS}). */
export type FeatureKind = (typeof FEATURE_KINDS)[number];

/**
 * A tab is no longer always a web page. Each tab carries a `kind` that decides
 * what renders in the stage:
 *   web      — a live WebContentsView (the embedded browser)
 *   home     — the New Tab dashboard / launcher (React)
 *   terminal — an integrated shell (React)
 *   editor   — a code editor (React)
 *   settings — the app settings surface (React)
 *   agent    — the full-surface AI Chat (React; also mirrored in the drawer)
 * Only `web` owns a WebContentsView; feature kinds render in the React stage.
 */
export type TabKind = 'web' | FeatureKind;

export type TabState = NavState & {
  id: string;
  kind: TabKind;
  /**
   * For `editor` tabs: the workspace-relative path of the open file (POSIX
   * separators), or undefined for a blank editor. Display/binding only — every
   * actual file read/write re-validates the path in the main process.
   */
  filePath?: string;
  /**
   * Pinned tabs render favicon-only (no title, no close) and are kept at the
   * front of the strip — main enforces the pinned-first ordering, so the
   * renderer just reflects it. Chrome/Edge "Pin tab".
   */
  pinned?: boolean;
};

export type TabsSnapshot = {
  tabs: TabState[];
  activeTabId: string | null;
};

/** A zeroed navigation state — feature tabs and freshly-created tabs use this. */
export const ZERO_NAV: NavState = {
  url: '',
  title: '',
  canGoBack: false,
  canGoForward: false,
  isLoading: false,
  isSecure: false,
  favicon: '',
  crashed: false,
  zoomFactor: 1,
};

/**
 * Final tab-id order for a reorder: the requested order (restricted to ids that
 * still exist), then any current ids the request omitted, kept in their
 * existing order. Shared by the optimistic renderer reorder and the
 * authoritative main-process reorder so the two policies can't diverge.
 */
export function applyReorder(
  currentIds: string[],
  orderedIds: string[],
): string[] {
  const current = new Set(currentIds);
  const next = orderedIds.filter((id) => current.has(id));
  const seen = new Set(next);
  for (const id of currentIds) {
    if (!seen.has(id)) next.push(id);
  }
  return next;
}
