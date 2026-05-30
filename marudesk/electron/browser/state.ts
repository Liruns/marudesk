import type { BrowserWindow, WebContentsView } from 'electron';
import {
  ZERO_NAV,
  type NavState,
  type TabKind,
  type TabState,
  type TabsSnapshot,
} from '../../shared/browser';
import type { DevtoolsDock } from '../../shared/settings';

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
  // Custom browser DevTools for a 'web' tab: the docked view (null in the
  // detached 'popup' mode or when closed) and which mode is currently open
  // (null = closed).
  devtoolsView?: WebContentsView | null;
  devtoolsMode?: DevtoolsDock | null;
  // Sync guard so a rapid second F12 can't create a second docked view while
  // the first open is still awaiting settings.
  devtoolsOpening?: boolean;
  // Custom CDP DevTools (electron/browser/cdp.ts): whether our debugger is
  // attached to this web tab, plus a sync guard against a re-entrant attach
  // race (two near-simultaneous cdp-send calls both seeing !isAttached).
  cdpAttached?: boolean;
  cdpAttaching?: boolean;
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

function navStateFor(view: WebContentsView): NavState {
  const wc = view.webContents;
  const url = wc.getURL();
  return {
    url,
    title: wc.getTitle(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    isLoading: wc.isLoading(),
    isSecure: url.startsWith('https://'),
  };
}

function tabStateFor(rec: TabRecord): TabState {
  if (rec.kind === 'web' && rec.view) {
    return { id: rec.id, kind: 'web', ...navStateFor(rec.view) };
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

/** Push the tab list and active-tab nav state to the renderer toolbar/strip. */
export function pushState(): void {
  if (!host || host.isDestroyed()) return;
  const snap = snapshot();
  host.webContents.send('browser:tabs-state', snap);
  const active = getActive();
  // Feature tabs have no navigation; report a zeroed nav so the toolbar resets.
  host.webContents.send(
    'browser:nav-state',
    active && active.view ? navStateFor(active.view) : ZERO_NAV,
  );
}
