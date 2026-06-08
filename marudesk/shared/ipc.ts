import { CHANNELS } from './ipc-channels.ts';
import type { Capture } from './capture';
import type { AgentChatState, ThreadSummary } from './agent';
import type { LaneDevState } from './lanes';
import type { NavState, TabsSnapshot } from './browser';
import type { DownloadEntry } from './downloads';
import type { AppSettings } from './settings';
import type { UpdateStatus } from './app-info';
import type { PairingRequestInfo, RelayStatus, ServerStatus } from './remote';
import type { TerminalDataEvent, TerminalExitEvent } from './terminal';
import type { WorkspaceSnapshot } from './workspace';
import type { DiagnosticsState } from './diagnostics';
import type { IpcMap } from './ipc-map.ts';
/**
 * The single source of truth for the renderer↔main IPC contract.
 *
 * - {@link CHANNELS} groups invoke channels per domain. A new domain adds one
 *   entry; the flat {@link INVOKE_CHANNELS} whitelist and the {@link InvokeChannel}
 *   union are *derived* so they can never drift from the groups.
 * - {@link IpcMap} maps each channel to its request args + response type, so
 *   `window.marudesk.invoke` is fully typed (see src/types/global.d.ts). The
 *   `_AssertInvokeCovered`/`_AssertNoExtraInvoke` guards below make the map and
 *   the channel list provably equal at compile time.
 * - {@link EventPayloadMap} does the same for main→renderer events, replacing the
 *   former hand-nested conditional type.
 */

export type { Rect, IpcMap } from './ipc-map.ts';

/* ── Invoke channels, grouped by domain (CHANNELS extracted to ./ipc-channels) ── */

export { CHANNELS } from './ipc-channels.ts';

type ChannelGroups = typeof CHANNELS;
export type InvokeChannel = ChannelGroups[keyof ChannelGroups][number];

/** Flat whitelist derived from {@link CHANNELS} — used by the preload bridge. */
export const INVOKE_CHANNELS: readonly InvokeChannel[] = Object.values(
  CHANNELS,
).flat() as InvokeChannel[];

export type InvokeArgs<C extends InvokeChannel> = IpcMap[C]['args'];
export type InvokeResult<C extends InvokeChannel> = IpcMap[C]['result'];

/* ── Events: main → renderer ────────────────────────────────────────────── */

export interface EventPayloadMap {
  'browser:capture': Capture;
  'browser:inspect-exit': void;
  'browser:nav-state': NavState;
  'browser:tabs-state': TabsSnapshot;
  // Ctrl/Cmd+L pressed while the web view itself had focus: the main process
  // can't focus the React address bar directly, so it asks the renderer to
  // (same idea as devtools:toggle). No payload.
  'browser:focus-address-bar': void;
  // Ctrl/Cmd+F from the focused web page: open the renderer's find bar.
  'browser:open-find': void;
  // Async match counts for the find bar (fires repeatedly per search; the last
  // carries finalUpdate=true). Active web tab only.
  'browser:found-in-page': {
    activeMatchOrdinal: number;
    matches: number;
    finalUpdate: boolean;
  };
  // The full download list, pushed (coalesced) whenever it changes.
  'browser:downloads': DownloadEntry[];
  // CDP events, coalesced per tab and delivered as a batch (see cdp.ts).
  // `dropped` = events shed when a flooding page overran the per-tick cap, so
  // the renderer can surface "N dropped" instead of silently losing them.
  'devtools:cdp-event': {
    tabId: string;
    items: { sessionId?: string; method: string; params: unknown }[];
    dropped?: number;
  };
  // An external detach (crash / built-in DevTools opened) — the renderer drops
  // its session and re-attaches on next open.
  'devtools:detached': { tabId: string; reason: string };
  // In-page F12 / Ctrl+Shift+I while the web view itself has focus: the main
  // process can't reach the React dock directly, so it asks the renderer to
  // toggle DevTools for this (active) tab — same path as the toolbar wrench.
  'devtools:toggle': { tabId: string };
  // Context-menu "Inspect Element": open the dock and select the node under the
  // given page-space point (CDP DOM.getNodeForLocation).
  'devtools:inspect-at': { tabId: string; x: number; y: number };
  // Always-on console capture (P0): the current error count for a tab's ring
  // buffer, pushed (coalesced) when it changes or resets on navigation. Drives
  // the DevTools toggle's error badge without the dock being open.
  'devtools:error-count': { tabId: string; count: number };
  // Agentic AI Chat: the full server-owned chat state, pushed (coalesced per
  // tick) whenever a turn advances. The renderer replaces its projection
  // wholesale — see docs/agentic-chat-design.md §8.
  'agent:event': AgentChatState;
  // Open conversation threads (Stage 12-B-2), pushed on every agent emit + on
  // thread create/switch/close so the thread switcher stays live.
  'agent:threads': ThreadSummary[];
  // Per-lane dev server status (§3.8), pushed on start/url-detect/exit.
  'lanes:dev-state': LaneDevState[];
  // Workspace deck state, pushed when a legacy or multi-workspace IPC mutation
  // changes the active workspace/root set.
  'workspaces:state': WorkspaceSnapshot;
  // Workspace diagnostics (Tier 1): pushed as a checker pass starts and finishes
  // so the Problems panel + Monaco markers update without polling.
  'diagnostics:update': DiagnosticsState;
  // Cloud relay (Bridge Model B §B2): the sanitized status, pushed when the host
  // connects/disconnects or the session changes (so the Settings UI reflects the
  // connected-as-host indicator live). Never carries tokens.
  'relay:status-changed': RelayStatus;
  // bridge server status (T2): pushed when the server starts/stops so the Settings
  // Remote panel reflects running state + reachable URLs live. Never the token.
  'server:status-changed': ServerStatus;
  // device pairing (T2 ③): a phone POSTed /pair with a valid code+proof and is
  // awaiting the PC user's approve/reject. The card shows name + fingerprint.
  'server:pairing-request': PairingRequestInfo;
  'window:maximize-state': boolean;
  'settings:changed': AppSettings;
  // Windows in-app auto-update (electron-updater, electron/updater.ts): the live
  // updater state, pushed as it checks / downloads / finishes so the About panel
  // can show progress + a "restart to install" button without polling.
  'app:update-status-changed': UpdateStatus;
  'terminal:data': TerminalDataEvent;
  'terminal:exit': TerminalExitEvent;
  // App-level zoom intent forwarded from main's host before-input-event, which
  // intercepts Ctrl/Cmd +/-/0 so Chromium's built-in (unmanaged, non-persisted)
  // zoom can't fire. The renderer applies page zoom for a web tab or scales the
  // whole UI (the persisted Interface-zoom setting) otherwise — symmetric in/out.
  'app:ui-zoom': 'in' | 'out' | 'reset';
  // Tab + split-pane shortcuts forwarded from a focused web view's
  // before-input-event. The renderer owns the tab/grid state, so main just relays
  // the intent — mirrors app:ui-zoom. Tab nav: Ctrl+Tab cycle (`jump` digit is
  // 1-based; 9 = last tab). Pane: Ctrl+Alt+Arrow cycles pane focus, Ctrl+Shift+
  // Enter zooms the focused pane.
  'app:tab-shortcut':
    | { type: 'cycle'; dir: 1 | -1 }
    | { type: 'jump'; digit: number }
    | { type: 'close' }
    | { type: 'pane-cycle'; dir: 1 | -1 }
    | { type: 'pane-maximize' };
}

export type EventChannel = keyof EventPayloadMap;
export type EventPayload<C extends EventChannel> = EventPayloadMap[C];

/** Runtime whitelist, kept in lockstep with {@link EventPayloadMap} by `satisfies`. */
export const EVENT_CHANNELS = [
  'browser:capture',
  'browser:inspect-exit',
  'browser:nav-state',
  'browser:tabs-state',
  'browser:focus-address-bar',
  'browser:open-find',
  'browser:found-in-page',
  'browser:downloads',
  'devtools:cdp-event',
  'devtools:detached',
  'devtools:toggle',
  'devtools:inspect-at',
  'devtools:error-count',
  'agent:event',
  'agent:threads',
  'lanes:dev-state',
  'workspaces:state',
  'diagnostics:update',
  'relay:status-changed',
  'server:status-changed',
  'server:pairing-request',
  'window:maximize-state',
  'settings:changed',
  'app:update-status-changed',
  'terminal:data',
  'terminal:exit',
  'app:ui-zoom',
  'app:tab-shortcut',
] as const satisfies readonly EventChannel[];

/* ── Compile-time coverage guards (no runtime cost) ─────────────────────── */

type Expect<T extends true> = T;
/**
 * Compile-time proof that {@link IpcMap} and {@link InvokeChannel} describe
 * exactly the same set of channels: every channel has a map entry, and the map
 * has no entry that isn't a channel. Exported so it counts as used; it carries
 * no runtime value. A drift here fails the build at the offending side.
 */
export type IpcMapIsComplete = [
  Expect<InvokeChannel extends keyof IpcMap ? true : false>,
  Expect<keyof IpcMap extends InvokeChannel ? true : false>,
];
