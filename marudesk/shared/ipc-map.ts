/**
 * The typed invoke request/response contract (`IpcMap`), split out of ipc.ts
 * so the `window.marudesk.invoke` map — the bulk of the file — lives on its
 * own. ipc.ts re-exports it and keeps the channel lists + completeness guards.
 */
import type { AppInfo, UpdateCheckResult, UpdateStatus } from './app-info';
import type { ProfileMeta, ProfilesState } from './profiles';
import type {
  AgentAnswers,
  AgentChatState,
  AgentEditActionResult,
  AgentSendInput,
  AgentSendResult,
} from './agent';
import type { ConsoleErrorEvidence } from './runtime-evidence';
import type { DiagnosticsState } from './diagnostics';
import type {
  ContextSyncPayload,
  MemoryEntry,
  MemoryEntryFull,
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
import type { WorktreeIsolationStatus, WorktreeMergeResult } from './worktree';
import type {
  BrowserNativeMenuItem,
  TabKind,
  TabsSnapshot,
} from './browser';
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
  SshConnectionInfo,
  SshConnectionInput,
  SshListDirResult,
  SshTestResult,
} from './ssh';
import type {
  PairedDeviceInfo,
  PairingStartInfo,
  RelayStatus,
  ServerStatus,
} from './remote';
import type {
  TerminalCreateOptions,
  TerminalCreated,
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

/** A pixel rectangle for positioning the embedded web views. */
export type Rect = { x: number; y: number; width: number; height: number };

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
  'browser:popup-menu': {
    args: [
      payload: {
        x: number;
        y: number;
        items: BrowserNativeMenuItem[];
      },
    ];
    result: string | null;
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
  // Add a folder on an SSH host as a new root of an existing workspace. The root
  // is indexed (git ls-files over SSH, else SFTP walk) before it's returned.
  'workspaces:add-ssh-root': {
    args: [
      payload: {
        workspaceId: WorkspaceId;
        connectionId: string;
        remotePath: string;
        name?: string;
      },
    ];
    result: WorkspaceRecord;
  };
  // Create a NEW workspace seeded with an SSH folder as its first root (the
  // "New workspace → SSH folder" flow). Indexed before it's returned.
  'workspaces:create-ssh': {
    args: [
      payload: {
        connectionId: string;
        remotePath: string;
        name?: string;
        workspaceName?: string;
      },
    ];
    result: WorkspaceRecord;
  };

  // ssh (remote connections — electron/ssh/*). `add`/`test` carry credentials
  // inbound; only the sanitized SshConnectionInfo ever comes back.
  'ssh:list-connections': { args: []; result: SshConnectionInfo[] };
  'ssh:add-connection': {
    args: [input: SshConnectionInput];
    result: SshConnectionInfo;
  };
  'ssh:remove-connection': {
    args: [payload: { connectionId: string }];
    result: { ok: true };
  };
  'ssh:test-connection': {
    args: [input: SshConnectionInput];
    result: SshTestResult;
  };
  'ssh:list-dir': {
    args: [payload: { connectionId: string; path: string }];
    result: SshListDirResult;
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
  // Worktree isolation (Stage 12-B): run the agent in an isolated worktree.
  'git:worktree-status': { args: []; result: WorktreeIsolationStatus };
  'git:worktree-enter': { args: []; result: WorktreeIsolationStatus };
  'git:worktree-merge': { args: []; result: WorktreeMergeResult };
  'git:worktree-discard': { args: []; result: { ok: true } };

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

  // diagnostics (workspace language support, Tier 1 — electron/diagnostics/*).
  // `run` runs the open project's own checker and parses its output; `get` pulls
  // the cached state. Live updates push on the `diagnostics:update` event.
  'diagnostics:run': { args: []; result: DiagnosticsState };
  'diagnostics:get': { args: []; result: DiagnosticsState };
  // Ensure + return the path to the user's languages.json (external checker
  // recipes), seeding a template on first open. Hand-edited, like mcp config.
  'diagnostics:open-config': { args: []; result: { path: string } };

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
  'agent:accept-edit': { args: [payload: { editId: string }]; result: AgentEditActionResult };
  'agent:revert-edit': { args: [payload: { editId: string }]; result: AgentEditActionResult };
  // User-initiated cancel of a running background agent from the tray (audit H6).
  'agent:cancel-background': { args: [payload: { id: string }]; result: boolean };
  // Steerable plan (v6 §U5): user toggles a step's status or removes it.
  'agent:edit-plan-step': {
    args: [payload: { id: string; status?: string; remove?: boolean }];
    result: boolean;
  };
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

  // Memory controls (v5 §G5): the Settings → Data panel lets the user see what
  // the agent has remembered, edit a note's body, or delete one. Backed by the
  // same memory-store the agent's list/read/write_memory tools use.
  'memory:list': { args: []; result: MemoryEntry[] };
  'memory:search': { args: [payload: { query: string }]; result: MemoryEntry[] };
  'memory:read': { args: [payload: { name: string }]; result: MemoryEntryFull | null };
  'memory:write': {
    args: [payload: { name: string; body: string }];
    result: { ok: boolean; name: string; reason?: string; evicted?: string[] };
  };
  'memory:delete': { args: [payload: { name: string }]; result: boolean };

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
  'mcp:add-preset': {
    args: [payload: { id: string }];
    result: McpServerStatus[];
  };
  'mcp:open-config': { args: []; result: { path: string } };
  // Whether the chrome-devtools (browser-control) preset is wired to marudesk's
  // embedded Chromium, and whether the remote-debugging port we attach to was opened
  // this launch. `required && !portOpen` → the user just enabled it and must restart
  // for it to drive the embedded browser (see electron/agent/embedded-browser.ts).
  'mcp:embedded-browser-status': {
    args: [];
    result: { portOpen: boolean; required: boolean };
  };

  // plugins — Settings → Plugins + composer slash commands. set-enabled returns
  // the fresh statuses so the panel reprojects without a follow-up fetch.
  'plugins:list': { args: []; result: PluginStatus[] };
  'plugins:reload': { args: []; result: PluginStatus[] };
  'plugins:set-enabled': {
    args: [payload: { id: string; enabled: boolean }];
    result: PluginStatus[];
  };
  'plugins:commands': { args: []; result: PluginCommandSnapshot[] };
  'plugins:open-folder': { args: []; result: { path: string } };

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
  'app:update-status': { args: []; result: UpdateStatus };
  'app:quit-and-install': { args: []; result: void };

  // ui — renderer-owned layout persisted to main JSON (opaque payload).
  'ui:get-layout': { args: []; result: unknown };
  'ui:set-layout': { args: [layout: unknown]; result: void };

  // profiles — isolated data sets; switch relaunches the app.
  'profiles:list': { args: []; result: ProfilesState };
  'profiles:create': { args: [name: string]; result: ProfileMeta };
  'profiles:rename': { args: [payload: { id: string; name: string }]; result: ProfilesState };
  'profiles:delete': { args: [id: string]; result: ProfilesState };
  'profiles:switch': { args: [id: string]; result: void };

  // window
  'window:minimize': { args: []; result: boolean };
  'window:maximize-toggle': { args: []; result: boolean };
  'window:close': { args: []; result: boolean };
  'window:is-maximized': { args: []; result: boolean };
}
