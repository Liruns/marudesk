import type { Capture } from './capture';
import type { NavState, TabKind, TabsSnapshot } from './browser';
import type { ProposeInput, ProposeResult } from './composer';
import type { ApplyResult, PatchOp, PatchPreview } from './patch';
import type { ModelDef, ProviderId, ProviderStatus } from './providers';
import type { AppSettings, SettingsPatch } from './settings';
import type {
  TerminalCreateOptions,
  TerminalCreated,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalInput,
  TerminalResize,
} from './terminal';
import type {
  CaptureInput,
  CreateKind,
  MutateResult,
  RankedFile,
  ReadFileResult,
  SaveAsResult,
  WorkspaceSummary,
  WriteFileResult,
} from './workspace';

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

/** A pixel rectangle for positioning the embedded web views. */
export type Rect = { x: number; y: number; width: number; height: number };

/* ── Invoke channels, grouped by domain ─────────────────────────────────── */

export const CHANNELS = {
  browser: [
    'browser:navigate',
    'browser:set-bounds',
    'browser:set-pane-bounds',
    'browser:clear-pane-bounds',
    'browser:set-inspect-mode',
    'browser:set-visible',
    'browser:go-back',
    'browser:go-forward',
    'browser:reload',
    'browser:stop',
    'browser:tabs-new',
    'browser:tabs-close',
    'browser:tabs-activate',
    'browser:tabs-snapshot',
    'browser:tabs-reorder',
    'browser:tabs-bind-path',
  ],
  devtools: [
    'devtools:open',
    'devtools:close',
    'devtools:open-chrome',
    'devtools:cdp-send',
    'devtools:set-dock-bounds',
  ],
  workspace: [
    'workspace:open',
    'workspace:list',
    'workspace:rank',
    'workspace:read-file',
    'workspace:write-file',
    'workspace:save-as',
    'workspace:create',
    'workspace:rename',
    'workspace:delete',
    'workspace:move',
    'workspace:copy',
    'workspace:reveal',
  ],
  patch: ['patch:preview', 'patch:apply'],
  secrets: [
    'secrets:list-providers',
    'secrets:set-provider-key',
    'secrets:clear-provider-key',
  ],
  providers: ['providers:list-models'],
  llm: ['llm:propose-patch'],
  settings: ['settings:get', 'settings:set', 'settings:reset'],
  terminal: [
    'terminal:create',
    'terminal:input',
    'terminal:resize',
    'terminal:dispose',
    'terminal:ready',
  ],
  window: [
    'window:minimize',
    'window:maximize-toggle',
    'window:close',
    'window:is-maximized',
  ],
} as const;

type ChannelGroups = typeof CHANNELS;
export type InvokeChannel = ChannelGroups[keyof ChannelGroups][number];

/** Flat whitelist derived from {@link CHANNELS} — used by the preload bridge. */
export const INVOKE_CHANNELS: readonly InvokeChannel[] = Object.values(
  CHANNELS,
).flat() as InvokeChannel[];

/* ── Typed invoke request/response map ──────────────────────────────────── */

/**
 * Per-channel `{ args, result }`. `args` is the tuple passed after the channel
 * name; `result` is the resolved value of the returned promise. Keep this in
 * sync with the `ipcMain.handle` signatures in electron/*.ts — the compile-time
 * guards below ensure every channel (and only those channels) appears here.
 */
export interface IpcMap {
  // browser
  'browser:navigate': { args: [url: string]; result: void };
  'browser:set-bounds': { args: [bounds: Rect]; result: void };
  'browser:set-pane-bounds': {
    args: [payload: { panes: { tabId: string; rect: Rect }[] }];
    result: void;
  };
  'browser:clear-pane-bounds': { args: []; result: void };
  'browser:set-inspect-mode': { args: [on: boolean]; result: void };
  'browser:set-visible': { args: [visible: boolean]; result: void };
  'browser:go-back': { args: []; result: boolean };
  'browser:go-forward': { args: []; result: boolean };
  'browser:reload': { args: []; result: boolean };
  'browser:stop': { args: []; result: boolean };
  'browser:tabs-new': {
    args: [payload: { kind?: TabKind; url?: string; path?: string }];
    result: string;
  };
  'browser:tabs-close': { args: [id: string]; result: boolean };
  'browser:tabs-activate': { args: [id: string]; result: boolean };
  'browser:tabs-snapshot': { args: []; result: TabsSnapshot };
  'browser:tabs-reorder': { args: [ids: string[]]; result: boolean };
  'browser:tabs-bind-path': {
    args: [payload: { id: string; path: string }];
    result: boolean;
  };
  // devtools (custom CDP DevTools — electron/browser/cdp.ts)
  'devtools:open': { args: [payload: { tabId: string }]; result: boolean };
  'devtools:close': { args: [payload: { tabId: string }]; result: boolean };
  // Escape hatch: toggle the built-in Chromium DevTools in a detached window for
  // the given tab. Detaches our CDP client first (single client per page), so the
  // React dock and Chromium DevTools are mutually exclusive. Returns false when
  // the tab isn't a web tab.
  'devtools:open-chrome': { args: [payload: { tabId: string }]; result: boolean };
  'devtools:cdp-send': {
    args: [
      payload: {
        tabId: string;
        sessionId?: string;
        method: string;
        params?: object;
      },
    ];
    // An envelope, not a thrown error: a failed CDP command (recoverable) must
    // be distinguishable from a dead session (which re-attaches).
    result: { ok: true; value: unknown } | { ok: false; error: string };
  };
  // Drag-time synchronous web-view shrink while dragging the dock splitter;
  // null = drag ended, normal set-bounds flow resumes.
  'devtools:set-dock-bounds': { args: [rect: Rect | null]; result: void };

  // workspace
  'workspace:open': { args: []; result: WorkspaceSummary | null };
  'workspace:list': { args: [root?: string]; result: WorkspaceSummary | null };
  'workspace:rank': { args: [capture: CaptureInput]; result: RankedFile[] };
  'workspace:read-file': { args: [rel: string]; result: ReadFileResult };
  'workspace:write-file': {
    args: [payload: { path: string; content: string }];
    result: WriteFileResult;
  };
  'workspace:save-as': {
    args: [payload: { content: string }];
    result: SaveAsResult;
  };
  'workspace:create': {
    args: [payload: { parentPath?: string; name: string; kind: CreateKind }];
    result: MutateResult;
  };
  'workspace:rename': {
    args: [payload: { path: string; newName: string }];
    result: MutateResult;
  };
  'workspace:delete': { args: [payload: { path: string }]; result: MutateResult };
  'workspace:move': {
    args: [payload: { from: string; toDir?: string }];
    result: MutateResult;
  };
  'workspace:copy': {
    args: [payload: { from: string; toDir?: string }];
    result: MutateResult;
  };
  'workspace:reveal': { args: [payload: { path: string }]; result: { ok: true } };

  // patch
  'patch:preview': { args: [ops: PatchOp[]]; result: PatchPreview };
  'patch:apply': { args: [ops: PatchOp[]]; result: ApplyResult };

  // secrets / providers / llm
  'secrets:list-providers': { args: []; result: ProviderStatus[] };
  'secrets:set-provider-key': {
    args: [provider: ProviderId, key: string];
    result: boolean;
  };
  'secrets:clear-provider-key': {
    args: [provider: ProviderId];
    result: boolean;
  };
  'providers:list-models': { args: [provider: ProviderId]; result: ModelDef[] };
  'llm:propose-patch': { args: [input: ProposeInput]; result: ProposeResult };

  // settings
  'settings:get': { args: []; result: AppSettings };
  'settings:set': { args: [partial: SettingsPatch]; result: AppSettings };
  'settings:reset': { args: []; result: AppSettings };

  // terminal
  'terminal:create': {
    args: [opts: TerminalCreateOptions];
    result: TerminalCreated;
  };
  'terminal:input': { args: [input: TerminalInput]; result: void };
  'terminal:resize': { args: [resize: TerminalResize]; result: void };
  'terminal:dispose': { args: [id: string]; result: void };
  'terminal:ready': { args: [payload: { id: string }]; result: void };

  // window
  'window:minimize': { args: []; result: boolean };
  'window:maximize-toggle': { args: []; result: boolean };
  'window:close': { args: []; result: boolean };
  'window:is-maximized': { args: []; result: boolean };
}

export type InvokeArgs<C extends InvokeChannel> = IpcMap[C]['args'];
export type InvokeResult<C extends InvokeChannel> = IpcMap[C]['result'];

/* ── Events: main → renderer ────────────────────────────────────────────── */

export interface EventPayloadMap {
  'browser:capture': Capture;
  'browser:inspect-exit': void;
  'browser:nav-state': NavState;
  'browser:tabs-state': TabsSnapshot;
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
  'window:maximize-state': boolean;
  'settings:changed': AppSettings;
  'terminal:data': TerminalDataEvent;
  'terminal:exit': TerminalExitEvent;
}

export type EventChannel = keyof EventPayloadMap;
export type EventPayload<C extends EventChannel> = EventPayloadMap[C];

/** Runtime whitelist, kept in lockstep with {@link EventPayloadMap} by `satisfies`. */
export const EVENT_CHANNELS = [
  'browser:capture',
  'browser:inspect-exit',
  'browser:nav-state',
  'browser:tabs-state',
  'devtools:cdp-event',
  'devtools:detached',
  'devtools:toggle',
  'devtools:inspect-at',
  'window:maximize-state',
  'settings:changed',
  'terminal:data',
  'terminal:exit',
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
