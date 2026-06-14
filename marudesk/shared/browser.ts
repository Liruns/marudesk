import type { WorkspaceFileRef, WorkspaceId } from './workspace';

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
  /**
   * The page is currently producing audible audio. Drives the toolbar's
   * speaker/mute affordance — Chrome only surfaces the control while a tab is
   * audible (or already muted).
   */
  audible: boolean;
  /** The tab's audio is muted (WebContents.setAudioMuted). Per-tab, sticky. */
  audioMuted: boolean;
};

/**
 * Feature tab kinds — every kind whose content is a React surface in the stage
 * (i.e. everything that is NOT the embedded web view). Declared once as an array
 * so the renderer's `TabKind` union *and* the main-process validator
 * (`isTabKind`) / title table (`FEATURE_TITLES`) all derive from this single
 * list and can't drift: add a kind here and it widens everywhere at once.
 */
export const FEATURE_KINDS = ['home', 'terminal', 'editor', 'settings', 'agent', 'plugin', 'devtools'] as const;

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
  workspaceId: WorkspaceId;
  editorFile?: WorkspaceFileRef;
  /**
   * For `editor` tabs: the workspace-relative path of the open file (POSIX
   * separators), or undefined for a blank editor. Display/binding only — every
   * actual file read/write re-validates the path in the main process.
   */
  filePath?: string;
  /**
   * For `plugin` tabs: which plugin panel renders, carried main→renderer the same
   * way `filePath` is for editor tabs (v2, §8.5). `id` is the plugin id and
   * `entry` its folder-relative panel HTML, loaded over `plugin://<id>/<entry>`.
   */
  pluginPanel?: { id: string; entry: string };
  /**
   * For `terminal` tabs: the command profile the PTY runs (absent = the user's
   * shell). `agent-cli` hosts the bundled chat CLI — the AI Chat-as-terminal
   * surface (chat CLI v2, docs/chat-cli-tui-design.md §6).
   */
  terminalProfile?: 'agent-cli';
  /**
   * For `devtools` tabs: the web tab this DevTools surface inspects. Carried
   * main→renderer like `filePath`, so a DevTools card/tab re-binds to its target
   * after a snapshot. The shared CDP relay is single-session, so one DevTools
   * surface is live at a time.
   */
  devtoolsTargetTabId?: string;
  /**
   * Pinned tabs render favicon-only (no title, no close) and are kept at the
   * front of the strip — main enforces the pinned-first ordering, so the
   * renderer just reflects it. Chrome/Edge "Pin tab".
   */
  pinned?: boolean;
  /**
   * The tab group this tab belongs to (a {@link TabGroup} id from the same
   * snapshot), or undefined when ungrouped. Members of one group are always a
   * contiguous run in the tab order; pinned tabs are never grouped.
   */
  groupId?: string;
};

/**
 * The tab-group color palette — a small, fixed set of token-backed hues
 * (`--tabgroup-*` in src/styles/tokens.css). The names double as the stable
 * wire/persistence values, so renaming a hue is a schema change.
 */
export const TAB_GROUP_COLORS = [
  'violet',
  'blue',
  'teal',
  'green',
  'amber',
  'rose',
] as const;

export type TabGroupColor = (typeof TAB_GROUP_COLORS)[number];

export function isTabGroupColor(value: unknown): value is TabGroupColor {
  return (
    typeof value === 'string' &&
    (TAB_GROUP_COLORS as readonly string[]).includes(value)
  );
}

/**
 * A Chrome-style tab group. Groups live WITHIN one workspace's tab strip:
 * members are a contiguous run in the tab order (main enforces contiguity on
 * every reorder), each tab referencing its group via `TabState.groupId`. Main
 * owns the records; the renderer mirrors them through {@link TabsSnapshot}.
 */
export type TabGroup = {
  id: string;
  workspaceId: WorkspaceId;
  /** Display name; '' renders as a color dot only (Chrome's unnamed group). */
  name: string;
  color: TabGroupColor;
  /** Collapsed groups hide their tabs from the strip (not from the registry). */
  collapsed: boolean;
};

export type TabsSnapshot = {
  tabs: TabState[];
  activeTabId: string | null;
  /** Open tab groups, ordered by each group's first member in the tab order. */
  groups: TabGroup[];
};

export type BrowserNativeMenuItem =
  | { readonly type: 'separator' }
  | {
      readonly id: string;
      readonly label: string;
      readonly enabled?: boolean;
      readonly shortcut?: string;
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
  audible: false,
  audioMuted: false,
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
