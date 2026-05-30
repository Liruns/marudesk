import type { BrowserWindow, WebContentsView } from 'electron';
import {
  ZERO_NAV,
  type NavState,
  type TabKind,
  type TabState,
  type TabsSnapshot,
} from '../../shared/browser';

/**
 * Shared mutable state for the embedded-browser/tab subsystem, plus the
 * low-level accessors the sibling modules build on. This module is the package
 * leaf: it imports none of layout/devtools/context-menu/navigation/tabs, so it
 * can be imported anywhere without cycles. The lifecycle verbs that mutate this
 * state (create/activate/close/reorder) live in ./tabs.
 */

export type Bounds = { x: number; y: number; width: number; height: number };

export type TabRecord = {
  id: string;
  kind: TabKind;
  // Only 'web' tabs own a WebContentsView; feature tabs (home/terminal/editor)
  // render in the React stage, so their view is null.
  view: WebContentsView | null;
  inspectOn: boolean;
  // For 'editor' tabs: the workspace-relative file path the tab is bound to.
  // Display/title only here — the read/write handlers re-validate every path.
  filePath?: string;
  // For an unsaved 'editor' tab (no filePath): its display name, e.g. Untitled-1.
  untitledName?: string;
  // Custom CDP DevTools (electron/browser/cdp.ts): whether our debugger is
  // attached to this web tab, plus a sync guard against a re-entrant attach
  // race (two near-simultaneous cdp-send calls both seeing !isAttached). The
  // React dock lives in the renderer; main only owns the debugger lifecycle.
  cdpAttached?: boolean;
  cdpAttaching?: boolean;
  // Escape hatch: the built-in Chromium DevTools is open (detached window) for
  // this tab. Mutually exclusive with `cdpAttached` (single CDP client/page).
  chromeDevtoolsOpen?: boolean;
  // Favicon as an inlined `data:` URL (electron/browser/favicon.ts), surfaced in
  // the tab strip. `faviconUrl` is the source the data URL was fetched from — it
  // doubles as the in-flight intent marker so a slow fetch resolving after a
  // newer favicon event (or a navigation) self-cancels.
  favicon?: string;
  faviconUrl?: string;
  // Renderer process died (render-process-gone, non-clean) and hasn't reloaded.
  // The layout engine keeps a crashed view hidden so the renderer can paint a
  // recovery card over the (now-revealed) React stage; cleared when a reload
  // begins (did-start-loading).
  crashed?: boolean;
  // Per-tab page zoom factor (1 = 100%); re-applied after navigation (zoom.ts).
  zoomFactor?: number;
};

// Titles for feature tabs (web tabs derive their title from the page).
const FEATURE_TITLES: Record<Exclude<TabKind, 'web'>, string> = {
  home: 'New Tab',
  terminal: 'Terminal',
  editor: 'Editor',
  settings: 'Settings',
};

// Renderer input is never trusted: validate the kind before acting on it.
export function isTabKind(value: unknown): value is TabKind {
  return (
    value === 'web' ||
    value === 'home' ||
    value === 'terminal' ||
    value === 'editor' ||
    value === 'settings'
  );
}

const tabs = new Map<string, TabRecord>();
let activeTabId: string | null = null;
let untitledSeq = 0;
let host: BrowserWindow | null = null;
let lastBounds: Bounds = { x: 0, y: 0, width: 0, height: 0 };
// Grid mode (Phase F): when the renderer's tab grid is active it pushes the
// pixel rect of every web-tab pane here. null = grid off (the single active-tab
// model). When set, `applyWebLayout` shows each listed web view at its rect and
// hides every other web view, generalizing the active-only model to "the web
// tabs currently tiled on the grid".
let paneBounds: Map<string, Bounds> | null = null;

/* ── host window ────────────────────────────────────────────────────────── */

export function getHost(): BrowserWindow | null {
  return host;
}

export function setHost(win: BrowserWindow | null): void {
  host = win;
}

/* ── active tab ─────────────────────────────────────────────────────────── */

export function getActiveTabId(): string | null {
  return activeTabId;
}

export function setActiveTabId(id: string | null): void {
  activeTabId = id;
}

export function getActive(): TabRecord | null {
  if (!activeTabId) return null;
  return tabs.get(activeTabId) ?? null;
}

/* ── layout bounds ──────────────────────────────────────────────────────── */

export function getLastBounds(): Bounds {
  return lastBounds;
}

export function setLastBounds(bounds: Bounds): void {
  lastBounds = bounds;
}

export function getPaneBounds(): Map<string, Bounds> | null {
  return paneBounds;
}

export function setPaneBounds(bounds: Map<string, Bounds> | null): void {
  paneBounds = bounds;
}

/* ── untitled editor sequence ───────────────────────────────────────────── */

export function nextUntitledSeq(): number {
  return ++untitledSeq;
}

/* ── tab map accessors ──────────────────────────────────────────────────── */

export function getTab(id: string): TabRecord | undefined {
  return tabs.get(id);
}

export function setTab(id: string, rec: TabRecord): void {
  tabs.set(id, rec);
}

export function deleteTab(id: string): boolean {
  return tabs.delete(id);
}

export function clearTabs(): void {
  tabs.clear();
}

export function tabValues(): TabRecord[] {
  return [...tabs.values()];
}

export function tabKeys(): string[] {
  return [...tabs.keys()];
}

/**
 * Rebuild the tab map in `order`. The Map preserves insertion order, which
 * every snapshot iterates, so this is the single source of tab order.
 */
export function reorderTabRecords(order: string[]): void {
  const next = new Map<string, TabRecord>();
  for (const id of order) {
    const rec = tabs.get(id);
    if (rec) next.set(id, rec);
  }
  tabs.clear();
  for (const [id, rec] of next) tabs.set(id, rec);
}

export function findTabByWebContentsId(senderId: number): TabRecord | null {
  for (const rec of tabs.values()) {
    if (rec.view && rec.view.webContents.id === senderId) return rec;
  }
  return null;
}

/* ── derived state / renderer push ──────────────────────────────────────── */

function navStateFor(rec: TabRecord): NavState {
  const view = rec.view;
  if (!view) return { ...ZERO_NAV, favicon: rec.favicon ?? '' };
  const wc = view.webContents;
  const url = wc.getURL();
  return {
    url,
    title: wc.getTitle(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    isLoading: wc.isLoading(),
    isSecure: url.startsWith('https://'),
    favicon: rec.favicon ?? '',
    crashed: rec.crashed ?? false,
    zoomFactor: rec.zoomFactor ?? 1,
  };
}

function tabStateFor(rec: TabRecord): TabState {
  if (rec.kind === 'web' && rec.view) {
    return { id: rec.id, kind: 'web', ...navStateFor(rec) };
  }
  if (rec.kind === 'editor') {
    const base = rec.filePath
      ? rec.filePath.split('/').pop() || rec.filePath
      : rec.untitledName ?? FEATURE_TITLES.editor;
    return {
      id: rec.id,
      kind: 'editor',
      ...ZERO_NAV,
      title: base,
      filePath: rec.filePath,
    };
  }
  return {
    id: rec.id,
    kind: rec.kind,
    ...ZERO_NAV,
    title: rec.kind === 'web' ? '' : FEATURE_TITLES[rec.kind],
  };
}

export function snapshot(): TabsSnapshot {
  const list: TabState[] = [];
  for (const rec of tabs.values()) {
    list.push(tabStateFor(rec));
  }
  return { tabs: list, activeTabId };
}

// `pushState` is called on every page event — and a single navigation emits a
// burst (did-start-loading → did-navigate → page-title-updated → favicon →
// did-stop-loading), each of which would otherwise fire TWO IPC sends (the full
// tabs snapshot + the nav state). A busy SPA spamming did-navigate-in-page /
// title updates multiplies that. Coalesce to one flush per tick (setImmediate),
// mirroring the CDP event relay in ./cdp: the renderer only needs to land on the
// latest snapshot, not replay every intermediate one. The synchronous pull path
// (`browser:tabs-snapshot` → `snapshot()`) is unaffected, so a renderer that
// needs state immediately can still ask for it.
let stateFlushScheduled = false;

function flushState(): void {
  stateFlushScheduled = false;
  if (!host || host.isDestroyed()) return;
  const snap = snapshot();
  host.webContents.send('browser:tabs-state', snap);
  const active = getActive();
  // Feature tabs have no navigation; report a zeroed nav so the toolbar resets.
  host.webContents.send(
    'browser:nav-state',
    active && active.view ? navStateFor(active) : ZERO_NAV,
  );
}

/**
 * Schedule a push of the tab list + active-tab nav state to the renderer
 * toolbar/strip, coalesced to once per tick. Collapsing a navigation's event
 * burst into a single flush keeps IPC volume flat while the renderer still lands
 * on the final, correct snapshot.
 */
export function pushState(): void {
  if (stateFlushScheduled) return;
  stateFlushScheduled = true;
  setImmediate(flushState);
}
