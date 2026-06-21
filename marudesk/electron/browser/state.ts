import type { BrowserWindow, WebContentsView } from 'electron';
import {
  ZERO_NAV,
  type NavState,
  type TabGroup,
  type TabKind,
  type TabState,
  type TabsSnapshot,
} from '../../shared/browser';
import {
  SYSTEM_WORKSPACE_ID,
  type WorkspaceFileRef,
  type WorkspaceId,
} from '../../shared/workspace';
import type { ConsoleErrorEvidence, ConsoleMessage } from '../../shared/runtime-evidence';
import type { NetworkRecord } from '../../shared/network-evidence';
import { coalesced } from '../coalesce';

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
  workspaceId: WorkspaceId;
  // Only 'web' tabs own a WebContentsView; feature tabs (home/terminal/editor)
  // render in the React stage, so their view is null.
  view: WebContentsView | null;
  inspectOn: boolean;
  // For 'editor' tabs: the workspace-relative file path the tab is bound to.
  // Display/title only here — the read/write handlers re-validate every path.
  filePath?: string;
  editorFile?: WorkspaceFileRef;
  // For an unsaved 'editor' tab (no filePath): its display name, e.g. Untitled-1.
  untitledName?: string;
  // For a 'plugin' tab: which plugin panel it renders (v2 — docs/plugin-runtime-design §8.5).
  pluginPanel?: { id: string; entry: string };
  // For a 'terminal' tab: the PTY command profile (chat CLI v2 §6.1). The
  // renderer names it; electron/terminal.ts decides what it spawns.
  terminalProfile?: 'agent-cli';
  // For a 'devtools' tab: the web tab id this DevTools surface inspects.
  devtoolsTargetTabId?: string;
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
  // Pinned tab: favicon-only in the strip, kept at the front. The action layer
  // (tabs.ts) re-sorts pinned-first whenever this flips or tabs reorder.
  pinned?: boolean;
  // Tab group (Chrome-style): the TabGroup record this tab belongs to, or
  // undefined when ungrouped. Members of one group stay a contiguous run in
  // the tab order — the verbs in ./tab-groups enforce that on every mutation.
  // Pinned tabs are never grouped (setTabPinned strips membership).
  groupId?: string;
};

// Titles for feature tabs (web tabs derive their title from the page).
const FEATURE_TITLES: Record<Exclude<TabKind, 'web'>, string> = {
  home: 'New Tab',
  terminal: 'Terminal',
  editor: 'Editor',
  settings: 'Settings',
  agent: 'AI Chat',
  plugin: 'Plugin',
  devtools: 'DevTools',
  files: 'Files',
  search: 'Search',
  sourceControl: 'Source Control',
};

// Renderer input is never trusted: validate the kind before acting on it.
export function isTabKind(value: unknown): value is TabKind {
  return (
    value === 'web' ||
    value === 'home' ||
    value === 'terminal' ||
    value === 'editor' ||
    value === 'settings' ||
    value === 'agent' ||
    value === 'plugin' ||
    value === 'devtools'
  );
}

const tabs = new Map<string, TabRecord>();
// Tab groups (Chrome-style), keyed by group id. Group ORDER is derived from
// the tab order (a group renders at its first member's slot), so the map needs
// no ordering of its own. Records whose last member closes are pruned.
const tabGroups = new Map<string, TabGroup>();
let activeTabId: string | null = null;
let untitledSeq = 0;
let host: BrowserWindow | null = null;
// The single pop-out DevTools window (electron/browser/devtools-window.ts), or
// null when docked. Tracked here (the package leaf) so cdp.ts can route CDP
// events to it while it's open without importing the window module (no cycle).
let devtoolsWindow: BrowserWindow | null = null;
let lastBounds: Bounds = { x: 0, y: 0, width: 0, height: 0 };
// Grid mode (Phase F): when the renderer's tab grid is active it pushes the
// pixel rect of every web-tab pane here. null = grid off (the single active-tab
// model). When set, `applyWebLayout` shows each listed web view at its rect and
// hides every other web view, generalizing the active-only model to "the web
// tabs currently tiled on the grid".
let paneBounds: Map<string, Bounds> | null = null;

// Always-on console capture (P0): a bounded ring of recent runtime errors per
// web tab, fed by the passive Runtime/Log CDP attach in ./cdp regardless of
// whether the DevTools dock is open. The dock seeds its console from this on
// open, and the "Fix this" loop reads it. Cleared on main-frame navigation
// (stale for the new document) and when the tab is deleted.
const MAX_ERRORS_PER_TAB = 50;
const errorBuffers = new Map<string, ConsoleErrorEvidence[]>();

// All-level console capture (DevTools 고도화 / M2): a parallel ring of EVERY
// console.* message (log/info/warning/error/debug), fed by the same always-on
// Runtime stream, for the agent's `read_console` tool — the wedge play of "the AI
// sees what the running app logged", not just errors. Bounded; cleared on nav/delete.
const MAX_CONSOLE_PER_TAB = 200;
const consoleBuffers = new Map<string, ConsoleMessage[]>();

// On-demand network capture (P0.5): the agent's `read_network` tool lazily
// enables Network on a tab and reads from this per-tab ring. Gated by
// `networkCaptureTabs` so the always-on path stays Runtime-only (no Network
// flood unless the agent asked). Records are raw; scrubbing happens at egress
// (the tool), never here. Cleared on navigation + tab delete, like errors.
const MAX_NETWORK_PER_TAB = 100;
const networkBuffers = new Map<string, NetworkRecord[]>();
const networkCaptureTabs = new Set<string>();

/* ── host window ────────────────────────────────────────────────────────── */

export function getHost(): BrowserWindow | null {
  return host;
}

export function setHost(win: BrowserWindow | null): void {
  host = win;
}

/* ── pop-out DevTools window ────────────────────────────────────────────── */

export function getDevtoolsWindow(): BrowserWindow | null {
  return devtoolsWindow;
}

export function setDevtoolsWindow(win: BrowserWindow | null): void {
  devtoolsWindow = win;
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

// The canvas surface's zoom (1 = 100%); web views in the pane map render their
// page at this factor so content scales with the canvas. null when not driven by
// the canvas (e.g. the classic split grid, which leaves per-tab user zoom alone).
let paneScale: number | null = null;

export function getPaneScale(): number | null {
  return paneScale;
}

export function setPaneScale(scale: number | null): void {
  paneScale = scale;
}

// A screen-px rect a renderer overlay (e.g. an on-canvas context menu) occupies.
// Web views intersecting it are hidden by the layout engine so the overlay — which
// the native views composite ABOVE — isn't rendered behind a page. Precise, unlike
// a blanket hide-all: only the actually-covered cards blink out. null = no overlay.
let occluderRect: Bounds | null = null;

export function getOccluderRect(): Bounds | null {
  return occluderRect;
}

export function setOccluderRect(rect: Bounds | null): void {
  occluderRect = rect;
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
  errorBuffers.delete(id); // drop the always-on console-error buffer with the tab
  consoleBuffers.delete(id);
  networkBuffers.delete(id);
  networkCaptureTabs.delete(id);
  return tabs.delete(id);
}

export function clearTabs(): void {
  tabs.clear();
  tabGroups.clear();
}

/* ── tab-group map accessors ────────────────────────────────────────────── */

export function getTabGroup(id: string): TabGroup | undefined {
  return tabGroups.get(id);
}

export function setTabGroup(group: TabGroup): void {
  tabGroups.set(group.id, group);
}

export function deleteTabGroup(id: string): boolean {
  return tabGroups.delete(id);
}

export function tabGroupValues(): TabGroup[] {
  return [...tabGroups.values()];
}

/**
 * Drop group records that no longer have a member tab (the last member was
 * closed / replaced / ungrouped) — Chrome deletes empty groups the same way.
 */
export function pruneEmptyTabGroups(): void {
  const live = new Set<string>();
  for (const rec of tabs.values()) {
    if (rec.groupId) live.add(rec.groupId);
  }
  for (const id of [...tabGroups.keys()]) {
    if (!live.has(id)) tabGroups.delete(id);
  }
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

/* ── always-on console-error buffer (P0) ────────────────────────────────── */

/** Append an error to a tab's ring buffer; returns the new count. */
export function pushError(tabId: string, ev: ConsoleErrorEvidence): number {
  let buf = errorBuffers.get(tabId);
  if (!buf) {
    buf = [];
    errorBuffers.set(tabId, buf);
  }
  buf.push(ev);
  if (buf.length > MAX_ERRORS_PER_TAB) buf.splice(0, buf.length - MAX_ERRORS_PER_TAB);
  return buf.length;
}

/** A tab's buffered errors (oldest-first). A fresh array each call (immutable to callers). */
export function getErrors(tabId: string): ConsoleErrorEvidence[] {
  const buf = errorBuffers.get(tabId);
  return buf ? [...buf] : [];
}

export function clearErrors(tabId: string): void {
  errorBuffers.delete(tabId);
}

export function errorCount(tabId: string): number {
  return errorBuffers.get(tabId)?.length ?? 0;
}

/* ── all-level console buffer (M2 — agent read_console) ─────────────────── */

/** Append a console message to a tab's all-level ring. */
export function pushConsole(tabId: string, msg: ConsoleMessage): void {
  let buf = consoleBuffers.get(tabId);
  if (!buf) {
    buf = [];
    consoleBuffers.set(tabId, buf);
  }
  buf.push(msg);
  if (buf.length > MAX_CONSOLE_PER_TAB) buf.splice(0, buf.length - MAX_CONSOLE_PER_TAB);
}

/** A tab's buffered console messages (oldest-first). A fresh array each call. */
export function getConsole(tabId: string): ConsoleMessage[] {
  const buf = consoleBuffers.get(tabId);
  return buf ? [...buf] : [];
}

export function clearConsole(tabId: string): void {
  consoleBuffers.delete(tabId);
}

/* ── on-demand network buffer (P0.5) ────────────────────────────────────── */

export function isNetworkCaptureOn(tabId: string): boolean {
  return networkCaptureTabs.has(tabId);
}

export function setNetworkCapture(tabId: string, on: boolean): void {
  if (on) networkCaptureTabs.add(tabId);
  else {
    networkCaptureTabs.delete(tabId);
    networkBuffers.delete(tabId);
  }
}

/** Append a network record; latest write wins per requestId (response after-fail). */
export function pushNetwork(tabId: string, rec: NetworkRecord): void {
  let buf = networkBuffers.get(tabId);
  if (!buf) {
    buf = [];
    networkBuffers.set(tabId, buf);
  }
  const existing = buf.findIndex((r) => r.requestId === rec.requestId);
  if (existing >= 0) buf[existing] = { ...buf[existing], ...rec };
  else buf.push(rec);
  if (buf.length > MAX_NETWORK_PER_TAB) buf.splice(0, buf.length - MAX_NETWORK_PER_TAB);
}

export function getNetwork(tabId: string): NetworkRecord[] {
  const buf = networkBuffers.get(tabId);
  return buf ? [...buf] : [];
}

export function clearNetwork(tabId: string): void {
  networkBuffers.delete(tabId);
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
    audible: wc.isCurrentlyAudible(),
    audioMuted: wc.isAudioMuted(),
  };
}

function tabStateFor(rec: TabRecord): TabState {
  const pinned = !!rec.pinned;
  if (rec.kind === 'web' && rec.view) {
    return {
      id: rec.id,
      kind: 'web',
      workspaceId: rec.workspaceId,
      pinned,
      ...navStateFor(rec),
    };
  }
  if (rec.kind === 'editor') {
    const displayPath = rec.editorFile?.path ?? rec.filePath;
    const base = displayPath
      ? displayPath.split('/').pop() || displayPath
      : rec.untitledName ?? FEATURE_TITLES.editor;
    return {
      id: rec.id,
      kind: 'editor',
      workspaceId: rec.workspaceId,
      pinned,
      ...ZERO_NAV,
      title: base,
      filePath: rec.filePath,
      editorFile: rec.editorFile,
    };
  }
  if (rec.kind === 'plugin') {
    return {
      id: rec.id,
      kind: 'plugin',
      workspaceId: rec.workspaceId ?? SYSTEM_WORKSPACE_ID,
      pinned,
      ...ZERO_NAV,
      title: rec.pluginPanel?.id ?? FEATURE_TITLES.plugin,
      pluginPanel: rec.pluginPanel,
    };
  }
  if (rec.kind === 'terminal' && rec.terminalProfile) {
    return {
      id: rec.id,
      kind: 'terminal',
      workspaceId: rec.workspaceId ?? SYSTEM_WORKSPACE_ID,
      pinned,
      ...ZERO_NAV,
      title: 'AI Chat (CLI)',
      terminalProfile: rec.terminalProfile,
    };
  }
  if (rec.kind === 'devtools') {
    return {
      id: rec.id,
      kind: 'devtools',
      workspaceId: rec.workspaceId ?? SYSTEM_WORKSPACE_ID,
      pinned,
      ...ZERO_NAV,
      title: FEATURE_TITLES.devtools,
      devtoolsTargetTabId: rec.devtoolsTargetTabId,
    };
  }
  return {
    id: rec.id,
    kind: rec.kind,
    workspaceId: rec.workspaceId ?? SYSTEM_WORKSPACE_ID,
    pinned,
    ...ZERO_NAV,
    title: rec.kind === 'web' ? '' : FEATURE_TITLES[rec.kind],
  };
}

export function snapshot(): TabsSnapshot {
  const list: TabState[] = [];
  const groups: TabGroup[] = [];
  const seenGroups = new Set<string>();
  for (const rec of tabs.values()) {
    const state = tabStateFor(rec);
    if (rec.groupId) {
      state.groupId = rec.groupId;
      // Emit each group once, at its first member — so the snapshot's group
      // order matches where the chip renders in the strip.
      const group = tabGroups.get(rec.groupId);
      if (group && !seenGroups.has(group.id)) {
        seenGroups.add(group.id);
        groups.push({ ...group });
      }
    }
    list.push(state);
  }
  return { tabs: list, activeTabId, groups };
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
function flushState(): void {
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
export const pushState = coalesced(flushState);
