import type { AppInfo, UpdateCheckResult } from './app-info';
import type { Capture } from './capture';
import type {
  AgentAnswers,
  AgentChatState,
  AgentSendInput,
  AgentSendResult,
} from './agent';
import type { ConsoleErrorEvidence } from './runtime-evidence';
import type {
  ContextSyncPayload,
  SessionSearchHit,
  SessionSummary,
  StorageStats,
} from './context';
import type {
  GitAvailability,
  GitBranches,
  GitCommit,
  GitCommitResult,
  GitRemoteResult,
  GitStatus,
} from './git';
import type { SearchOptions, SearchResult } from './search';
import type { NavState, TabKind, TabsSnapshot } from './browser';
import type { McpServerStatus } from './mcp';
import type { PluginCommandSnapshot, PluginStatus } from './plugin';
import type { DownloadAction, DownloadEntry } from './downloads';
import type { HistoryEntry } from './history';
import type { ApplyResult, PatchOp, PatchPreview } from './patch';
import type {
  CustomProviderInfo,
  CustomProviderInput,
  ModelDef,
  OAuthFlow,
  ProviderId,
  ProviderStatus,
} from './providers';
import type { AppSettings, SettingsPatch } from './settings';
import type {
  PairedDeviceInfo,
  PairingRequestInfo,
  PairingStartInfo,
  RelayStatus,
  ServerStatus,
} from './remote';
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
  ReadMediaResult,
  SaveAsResult,
  WorkspaceFileRef,
  WorkspaceId,
  WorkspacePaneId,
  WorkspaceRecord,
  WorkspaceRootId,
  WorkspaceRootInput,
  WorkspaceSummary,
  WorkspaceSnapshot,
  WorkspaceSaveAsResult,
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
    'browser:find',
    'browser:stop-find',
    'browser:zoom',
    'browser:set-audio-muted',
    'browser:capture-page',
    'browser:downloads-list',
    'browser:download-action',
    'browser:downloads-clear',
    'browser:tabs-new',
    'browser:tabs-replace',
    'browser:tabs-close',
    'browser:tabs-reopen',
    'browser:tabs-activate',
    'browser:tabs-snapshot',
    'browser:tabs-reorder',
    'browser:tabs-set-pinned',
    'browser:tabs-bind-path',
  ],
  devtools: [
    'devtools:open',
    'devtools:close',
    'devtools:open-chrome',
    'devtools:cdp-send',
    'devtools:set-dock-bounds',
    'devtools:popout-open',
    'devtools:popout-close',
    'devtools:pull-errors',
  ],
  workspace: [
    'workspace:open',
    'workspace:list',
    'workspace:rank',
    'workspace:read-file',
    'workspace:read-media',
    'workspace:write-file',
    'workspace:save-as',
    'workspace:create',
    'workspace:rename',
    'workspace:delete',
    'workspace:move',
    'workspace:copy',
    'workspace:reveal',
  ],
  workspaces: [
    'workspaces:list',
    'workspaces:create',
    'workspaces:add-root',
    'workspaces:remove-root',
    'workspaces:rename',
    'workspaces:delete',
    'workspaces:set-active',
    'workspaces:set-active-root',
    'workspaces:reindex',
    'workspaces:read-file',
    'workspaces:write-file',
    'workspaces:save-as',
    'workspaces:rank',
  ],
  history: ['history:query', 'history:recent'],
  // Workspace Source Control (electron/git.ts). All run against the open
  // workspace root via execFile git (argv arrays, never a shell). `status`
  // returns isRepo:false cleanly when the folder isn't a repo; discards are
  // destructive and the renderer confirms before calling.
  git: [
    'git:available',
    'git:status',
    'git:init',
    'git:stage',
    'git:stageAll',
    'git:unstage',
    'git:discard',
    'git:diff',
    'git:commit',
    'git:branches',
    'git:checkout',
    'git:createBranch',
    'git:log',
    'git:fetch',
    'git:pull',
    'git:push',
  ],
  // Workspace content search (electron/search.ts). Prefers ripgrep, falls back
  // to a Node walk reusing the workspace IGNORE_DIRS + binary/size skips.
  search: ['search:content'],
  patch: ['patch:preview', 'patch:apply'],
  secrets: [
    'secrets:list-providers',
    'secrets:set-provider-key',
    'secrets:clear-provider-key',
  ],
  providers: [
    'providers:list-models',
    'providers:test-connection',
    'providers:list-custom',
    'providers:add-custom',
    'providers:remove-custom',
  ],
  auth: [
    'auth:oauth-start',
    'auth:oauth-complete',
    'auth:oauth-cancel',
    'auth:oauth-disconnect',
  ],
  agent: [
    'agent:send',
    'agent:abort',
    'agent:respond',
    'agent:approve-tool',
    'agent:accept-edit',
    'agent:revert-edit',
    'agent:snapshot',
    'agent:reset',
    'agent:compact',
    'agent:list-sessions',
    'agent:search-sessions',
    'agent:resume-session',
    'agent:delete-session',
  ],
  // Local data store management — Settings → Data & Storage reads stats, clears
  // saved sessions, and reveals the data folder (docs/data-storage-design).
  storage: ['storage:stats', 'storage:clear-sessions', 'storage:reveal'],
  // The renderer mirrors surfaces main can't observe (unsaved editor buffers, the
  // explorer tree state) to the built-in context MCP — see context-mcp-design §3.
  context: ['context:sync'],
  // External (stdio) MCP connectors — Settings → MCP Servers lists/reloads/toggles
  // user-configured servers (docs/remote-mobile-bridge-design §M3).
  mcp: [
    'mcp:list-servers',
    'mcp:reload',
    'mcp:set-enabled',
    'mcp:open-config',
  ],
  // User plugins running in isolated workers — Settings → Plugins lists/reloads/
  // toggles them, and the composer reads the slash commands they contribute
  // (docs/plugin-runtime-design.md §5, §7 P2).
  plugins: [
    'plugins:list',
    'plugins:reload',
    'plugins:set-enabled',
    'plugins:commands',
  ],
  settings: ['settings:get', 'settings:set', 'settings:reset'],
  // Cloud relay (Bridge Model B §B2): log the PC's cloud account in/out and read
  // the sanitized status (logged-in account + connected-as-host). Tokens never
  // cross IPC — only `{account|null, connected}` does. Auto-connect is driven by
  // settings.server.cloudEnabled + login state in electron/server/relay.ts.
  relay: ['relay:login', 'relay:logout', 'relay:status'],
  // LAN/Tailscale bridge status + device pairing (T2 — docs/remote-mobile-bridge-design
  // §3, docs/t2-secure-pairing-design.md). The Settings → Remote panel reads the
  // running flag + reachable URLs, starts a pairing (QR), approves/rejects an
  // incoming pairing, and lists/revokes paired devices. Never the token or any key.
  server: [
    'server:status',
    'server:pairing-start',
    'server:pairing-approve',
    'server:pairing-reject',
    'server:list-devices',
    'server:revoke-device',
  ],
  terminal: [
    'terminal:create',
    'terminal:input',
    'terminal:resize',
    'terminal:dispose',
    'terminal:ready',
  ],
  clipboard: ['clipboard:write-text', 'clipboard:read-text'],
  app: [
    'app:info',
    'app:open-github',
    'app:open-releases',
    'app:check-for-updates',
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
  // `ignoreCache` = a hard reload (Ctrl+Shift+R); omitted/false = a normal one.
  'browser:reload': { args: [ignoreCache?: boolean]; result: boolean };
  'browser:stop': { args: []; result: boolean };
  // In-page find (Ctrl+F). Match counts come back asynchronously on the
  // `browser:found-in-page` event, so the invoke itself resolves void.
  'browser:find': {
    args: [
      payload: {
        text: string;
        forward?: boolean;
        findNext?: boolean;
        matchCase?: boolean;
      },
    ];
    result: void;
  };
  'browser:stop-find': {
    args: [action?: 'clearSelection' | 'keepSelection' | 'activateSelection'];
    result: void;
  };
  // Per-tab page zoom (Ctrl +/-/0). Returns the new factor (1 = 100%); the
  // toolbar also gets it via NavState so it survives tab switches.
  'browser:zoom': {
    args: [payload: { direction: 'in' | 'out' | 'reset' }];
    result: number;
  };
  // Mute / unmute the active web tab's audio (Chrome's tab speaker toggle).
  'browser:set-audio-muted': { args: [muted: boolean]; result: void };
  // Capture the active page to a PNG on the clipboard. Returns false when there's
  // no active web view to capture.
  'browser:capture-page': { args: []; result: boolean };
  // Download manager. The live list is also pushed on the browser:downloads
  // event whenever it changes; this invoke is the pull for an initial render.
  'browser:downloads-list': { args: []; result: DownloadEntry[] };
  'browser:download-action': {
    args: [payload: { id: string; action: DownloadAction }];
    result: boolean;
  };
  'browser:downloads-clear': { args: []; result: void };
  'browser:tabs-new': {
    args: [
      payload: {
        kind?: TabKind;
        url?: string;
        path?: string;
        workspaceId?: WorkspaceId;
        file?: WorkspaceFileRef;
        /** For a `plugin` tab: which plugin panel to render (v2). */
        pluginPanel?: { id: string; entry: string };
      },
    ];
    result: string;
  };
  // Convert an existing tab into another kind in place (keeps its strip slot).
  // The New Tab page uses this so a launcher click / URL entry replaces the home
  // tab rather than opening a second tab. Returns the new tab id, or null if the
  // target tab no longer exists.
  'browser:tabs-replace': {
    args: [
      payload: {
        id: string;
        kind?: TabKind;
        url?: string;
        path?: string;
        workspaceId?: WorkspaceId;
        file?: WorkspaceFileRef;
      },
    ];
    result: string | null;
  };
  'browser:tabs-close': { args: [id: string]; result: boolean };
  'browser:tabs-reopen': { args: []; result: boolean };
  'browser:tabs-activate': { args: [id: string]; result: boolean };
  'browser:tabs-snapshot': { args: []; result: TabsSnapshot };
  'browser:tabs-reorder': { args: [ids: string[]]; result: boolean };
  // Pin/unpin a tab (favicon-only, kept at the front). Main re-sorts pinned-first.
  'browser:tabs-set-pinned': {
    args: [payload: { id: string; pinned: boolean }];
    result: boolean;
  };
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
  // Pop the React DevTools out into its own framed BrowserWindow bound to the
  // given web tab (electron/browser/devtools-window.ts). The in-window dock
  // detaches its CDP session first; the popup re-attaches (single client per
  // page). Returns false when the tab isn't a web tab. `popout-close` closes the
  // single popup (called by the popup's "Dock back" button before window.close).
  'devtools:popout-open': { args: [payload: { tabId: string }]; result: boolean };
  'devtools:popout-close': { args: []; result: void };
  // Always-on console capture (P0): drain the main-process per-tab error ring
  // buffer — the dock seeds its console from this on open, and "Fix this" reads
  // it even when the dock was never opened. Empty array for a non-web tab.
  'devtools:pull-errors': {
    args: [payload: { tabId: string }];
    result: ConsoleErrorEvidence[];
  };

  // workspace
  'workspace:open': { args: []; result: WorkspaceSummary | null };
  'workspace:list': { args: [root?: string]; result: WorkspaceSummary | null };
  'workspace:rank': { args: [capture: CaptureInput]; result: RankedFile[] };
  'workspace:read-file': { args: [rel: string]; result: ReadFileResult };
  'workspace:read-media': { args: [rel: string]; result: ReadMediaResult };
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

  'workspaces:list': { args: []; result: WorkspaceSnapshot };
  'workspaces:create': {
    // `roots` may be omitted/empty: the main process then opens a native folder
    // picker and a cancel returns null (no workspace created).
    args: [payload: { name?: string; roots?: WorkspaceRootInput[] }];
    result: WorkspaceRecord | null;
  };
  'workspaces:add-root': {
    args: [payload: { workspaceId: WorkspaceId; name?: string; path?: string }];
    result: WorkspaceRecord;
  };
  'workspaces:remove-root': {
    args: [payload: { workspaceId: WorkspaceId; rootId: WorkspaceRootId }];
    result: WorkspaceRecord;
  };
  'workspaces:rename': {
    args: [payload: { workspaceId: WorkspaceId; name: string }];
    result: WorkspaceRecord;
  };
  'workspaces:delete': {
    args: [payload: { workspaceId: WorkspaceId }];
    result: WorkspaceSnapshot;
  };
  'workspaces:set-active': {
    args: [payload: { workspaceId: WorkspaceId; paneId?: WorkspacePaneId }];
    result: WorkspaceSnapshot;
  };
  'workspaces:set-active-root': {
    args: [payload: { workspaceId: WorkspaceId; rootId: WorkspaceRootId }];
    result: WorkspaceSnapshot;
  };
  'workspaces:reindex': {
    args: [payload: { workspaceId: WorkspaceId; rootId?: WorkspaceRootId }];
    result: WorkspaceRecord;
  };
  'workspaces:read-file': { args: [file: WorkspaceFileRef]; result: ReadFileResult };
  'workspaces:write-file': {
    args: [payload: { file: WorkspaceFileRef; content: string }];
    result: WriteFileResult;
  };
  'workspaces:save-as': {
    args: [payload: { workspaceId: WorkspaceId; rootId: WorkspaceRootId; content: string }];
    result: WorkspaceSaveAsResult;
  };
  'workspaces:rank': {
    args: [payload: { workspaceId: WorkspaceId; rootId?: WorkspaceRootId; capture: CaptureInput }];
    result: RankedFile[];
  };

  // git (Source Control — electron/git.ts). Paths are workspace-relative POSIX.
  // `status` never throws for a non-repo (returns { isRepo: false }); `discard`
  // is destructive (renderer confirms first); remote ops never force.
  'git:available': { args: []; result: GitAvailability };
  'git:status': { args: []; result: GitStatus };
  'git:init': { args: []; result: { ok: true } };
  'git:stage': { args: [payload: { paths: string[] }]; result: { ok: true } };
  'git:stageAll': { args: []; result: { ok: true } };
  'git:unstage': { args: [payload: { paths: string[] }]; result: { ok: true } };
  'git:discard': { args: [payload: { paths: string[] }]; result: { ok: true } };
  'git:diff': {
    args: [payload: { path: string; staged: boolean }];
    result: { diff: string };
  };
  'git:commit': {
    args: [payload: { message: string; amend?: boolean }];
    result: GitCommitResult;
  };
  'git:branches': { args: []; result: GitBranches };
  'git:checkout': { args: [payload: { name: string }]; result: { ok: true } };
  'git:createBranch': {
    args: [payload: { name: string; checkout?: boolean }];
    result: { ok: true };
  };
  'git:log': { args: []; result: GitCommit[] };
  'git:fetch': { args: []; result: GitRemoteResult };
  'git:pull': { args: []; result: GitRemoteResult };
  'git:push': { args: []; result: GitRemoteResult };

  // search (content search — electron/search.ts)
  'search:content': {
    args: [payload: { query: string; opts: SearchOptions }];
    result: SearchResult;
  };

  // patch
  'patch:preview': { args: [ops: PatchOp[]]; result: PatchPreview };
  'patch:apply': { args: [ops: PatchOp[]]; result: ApplyResult };

  // history (address-bar autocomplete)
  'history:query': { args: [query: string]; result: HistoryEntry[] };
  'history:recent': { args: []; result: HistoryEntry[] };

  // secrets / providers
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
  // A minimal live request to verify a provider's credentials actually work —
  // for the Settings "Test connection" button, especially OAuth providers, which
  // have no /models endpoint to probe. Returns a human-readable ok/error message.
  'providers:test-connection': {
    args: [provider: ProviderId];
    result: { ok: boolean; message: string };
  };
  // Custom OpenAI-compatible endpoints (OpenRouter / LM Studio / vLLM / …). The
  // config is non-secret (a plaintext file); the optional key lives in secrets
  // under `custom:<id>`. Each mutation returns the fresh list so the renderer
  // store reprojects without a follow-up fetch.
  'providers:list-custom': { args: []; result: CustomProviderInfo[] };
  'providers:add-custom': {
    args: [input: CustomProviderInput];
    result: CustomProviderInfo[];
  };
  'providers:remove-custom': { args: [id: string]; result: CustomProviderInfo[] };

  // OAuth login (docs/oauth-providers-design.md). All in main; tokens never reach
  // the renderer — only ProviderStatus.oauth (via secrets:list-providers) reflects
  // the connection. `start` generates PKCE, opens the system browser, and returns
  // the authorize URL + the `flow`: 'manual-paste' (the renderer shows a paste
  // field) or 'loopback' (a transient 127.0.0.1 server auto-captures the redirect,
  // so the renderer just calls `complete`, which blocks until the browser hits it).
  // `complete`'s `pasted` is the `code#state` / URL / code for manual-paste, unused
  // for loopback. `cancel` tears down a pending loopback wait.
  'auth:oauth-start': { args: [provider: ProviderId]; result: { flow: OAuthFlow; url: string } };
  'auth:oauth-complete': {
    args: [payload: { provider: ProviderId; pasted?: string }];
    result: boolean;
  };
  'auth:oauth-cancel': { args: [provider: ProviderId]; result: boolean };
  'auth:oauth-disconnect': { args: [provider: ProviderId]; result: boolean };

  // agent (agentic AI Chat — docs/agentic-chat-design.md). main owns the chat
  // state and streams it on the agent:event snapshot; these invokes drive it.
  'agent:send': { args: [input: AgentSendInput]; result: AgentSendResult };
  'agent:abort': { args: [payload: { turnId: string }]; result: boolean };
  // Resume a turn parked on an ask_user tool with the user's answers.
  'agent:respond': {
    args: [payload: { turnId: string; callId: string; answers: AgentAnswers }];
    result: boolean;
  };
  // Resume a turn parked on a gated tool (eval_js / navigation) approval.
  'agent:approve-tool': {
    args: [payload: { turnId: string; callId: string; approved: boolean; always?: boolean }];
    result: boolean;
  };
  // Keep (accept) or restore (revert `before`) one applied edit — roadmap P2.
  'agent:accept-edit': { args: [payload: { editId: string }]; result: boolean };
  'agent:revert-edit': { args: [payload: { editId: string }]; result: boolean };
  // Pull the current chat state (initial render / re-mount).
  'agent:snapshot': { args: []; result: AgentChatState };
  // Start a fresh conversation (clears transcript; keeps still-applied edits).
  'agent:reset': { args: []; result: boolean };
  // Compact the conversation: summarize the transcript for the model while
  // keeping the visible scrollback (claude-code / codex `/compact`). An optional
  // `focus` (from `/compact <focus>`) asks the summarizer to preserve specific
  // details. Returns ok, or a reason when there's nothing to compact.
  'agent:compact': { args: [focus?: string]; result: { ok: boolean; reason?: string } };
  // Session history (v3 §5-C): list past saved conversations, resume one as the
  // active chat, or delete one. The list backs the sessions UI; resume swaps state.
  'agent:list-sessions': { args: []; result: SessionSummary[] };
  'agent:search-sessions': {
    args: [payload: { query: string }];
    result: SessionSearchHit[];
  };
  'agent:resume-session': { args: [payload: { id: string }]; result: boolean };
  'agent:delete-session': { args: [payload: { id: string }]; result: boolean };

  // storage (Data & Storage settings panel): read store stats (backend +
  // session count + bytes), clear all saved sessions, and reveal the userData
  // folder in the OS file manager. Clearing returns the number removed.
  'storage:stats': { args: []; result: StorageStats };
  'storage:clear-sessions': { args: []; result: number };
  'storage:reveal': { args: []; result: void };

  // context (built-in MCP mirror): the renderer pushes the surfaces main can't
  // see (unsaved editor buffers + explorer tree state) on change. Fire-and-forget
  // (result void) — main caches it for the read_editor / read_explorer tools.
  'context:sync': { args: [payload: ContextSyncPayload]; result: void };

  // external (stdio) MCP connectors (docs/remote-mobile-bridge-design §M3). The
  // Settings UI lists per-server status, reloads from the config file, toggles a
  // server's enabled flag, and reveals the config file for hand-editing. Each
  // mutation returns the fresh statuses so the renderer reprojects without a
  // follow-up fetch.
  'mcp:list-servers': { args: []; result: McpServerStatus[] };
  'mcp:reload': { args: []; result: McpServerStatus[] };
  'mcp:set-enabled': {
    args: [payload: { id: string; enabled: boolean }];
    result: McpServerStatus[];
  };
  'mcp:open-config': { args: []; result: { path: string } };

  // plugins — Settings → Plugins + composer slash commands. set-enabled returns
  // the fresh statuses so the panel reprojects without a follow-up fetch.
  'plugins:list': { args: []; result: PluginStatus[] };
  'plugins:reload': { args: []; result: PluginStatus[] };
  'plugins:set-enabled': {
    args: [payload: { id: string; enabled: boolean }];
    result: PluginStatus[];
  };
  'plugins:commands': { args: []; result: PluginCommandSnapshot[] };

  // settings
  'settings:get': { args: []; result: AppSettings };
  'settings:set': { args: [partial: SettingsPatch]; result: AppSettings };
  'settings:reset': { args: []; result: AppSettings };

  // cloud relay (Bridge Model B §B2). `login` does email+password signup/login
  // against the relay, stores the session (tokens encrypted in main), and connects
  // as host when cloud is enabled. All return the sanitized status — never tokens.
  'relay:login': {
    args: [
      payload: {
        relayUrl: string;
        email: string;
        password: string;
        mode: 'login' | 'signup';
      },
    ];
    result: RelayStatus;
  };
  'relay:logout': { args: []; result: RelayStatus };
  'relay:status': { args: []; result: RelayStatus };

  // bridge server status (T2 — docs/remote-mobile-bridge-design §3). Read the
  // running flag + reachable LAN/Tailscale URLs for the Settings Remote panel;
  // pushed live on `server:status-changed`. Never carries the bearer token.
  'server:status': { args: []; result: ServerStatus };
  // device pairing (T2 ③ — docs/t2-secure-pairing-design.md). `pairing-start` mints
  // a QR (PC public key + reachable URLs + one-time code) for the phone to scan;
  // `pairing-approve`/`-reject` answer the desktop approval card (correlated by the
  // approvalId from the `server:pairing-request` event); `list/revoke-devices`
  // manage paired phones. Sanitized only — never a session key.
  'server:pairing-start': { args: []; result: PairingStartInfo };
  'server:pairing-approve': { args: [payload: { approvalId: string }]; result: boolean };
  'server:pairing-reject': { args: [payload: { approvalId: string }]; result: boolean };
  'server:list-devices': { args: []; result: PairedDeviceInfo[] };
  'server:revoke-device': {
    args: [payload: { deviceId: string }];
    result: PairedDeviceInfo[];
  };

  // terminal
  'terminal:create': {
    args: [opts: TerminalCreateOptions];
    result: TerminalCreated;
  };
  'terminal:input': { args: [input: TerminalInput]; result: void };
  'terminal:resize': { args: [resize: TerminalResize]; result: void };
  'terminal:dispose': { args: [id: string]; result: void };
  'terminal:ready': { args: [payload: { id: string }]; result: void };

  // clipboard (integrated-terminal copy/paste — electron/clipboard.ts)
  'clipboard:write-text': { args: [text: string]; result: void };
  'clipboard:read-text': { args: []; result: string };

  'app:info': { args: []; result: AppInfo };
  'app:open-github': { args: []; result: void };
  'app:open-releases': { args: []; result: void };
  'app:check-for-updates': { args: []; result: UpdateCheckResult };

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
  // Workspace deck state, pushed when a legacy or multi-workspace IPC mutation
  // changes the active workspace/root set.
  'workspaces:state': WorkspaceSnapshot;
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
  'workspaces:state',
  'relay:status-changed',
  'server:status-changed',
  'server:pairing-request',
  'window:maximize-state',
  'settings:changed',
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
