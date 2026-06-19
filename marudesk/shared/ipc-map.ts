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
  AgentToolInfo,
  ThreadSummary,
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
  GitBlameFile,
  GitBranches,
  GitCommit,
  GitCommitResult,
  GitConflictState,
  GitFileDiffLines,
  GitRemoteResult,
  GitStashEntry,
  GitStatus,
} from './git';
import type { SearchOptions, SearchResult } from './search';
import type {
  CheckpointRestore,
  WorktreeIsolationStatus,
  WorktreeLane,
  WorktreeMergeResult,
} from './worktree';
import type { Automation, AutomationInput, AutomationRun } from './automations';
import type { Workflow, WorkflowRunResult, WorkflowStep } from './workflows';
import type { Spec, SpecInput } from './specs';
import type {
  WorkGraph,
  RunTaskInput,
  RunTaskResult,
  ImplementTaskResult,
  ApplyPatchInput,
  ApplyPatchResult,
} from './work-os';
import type { LaneDevState, LaneDevStartResult } from './lanes';
import type { LaneGithubStatusResult } from './lane-github';
import type {
  BrowserNativeMenuItem,
  TabGroupColor,
  TabKind,
  TabsSnapshot,
} from './browser';
import type { McpConfigHealth, McpServerStatus } from './mcp';
import type { PluginCommandSnapshot, PluginStatus } from './plugin';
import type { BookmarkEntry, BookmarkInput } from './bookmarks';
import type { DownloadAction, DownloadEntry } from './downloads';
import type { HistoryEntry } from './history';
import type { Suggestion } from './suggest';
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
  SshPinnedHostKey,
  SshTestResult,
} from './ssh';
import type {
  CliCommandStatus,
  TerminalCreateOptions,
  TerminalCreated,
  TerminalInput,
  TerminalResize,
} from './terminal';
import type { UsageReport } from '../electron/usage/types';
import type { TerminalErrorEvent } from './terminal-evidence';
import type {
  CaptureInput,
  CreateKind,
  MutateResult,
  RankedFile,
  FileEntry,
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
  // Per-tab controls — the canvas drives a specific card's view by id without
  // changing the active tab or disturbing the multi-card grid layout.
  'browser:navigate-tab': { args: [payload: { tabId: string; url: string }]; result: void };
  'browser:go-back-tab': { args: [tabId: string]; result: boolean };
  'browser:go-forward-tab': { args: [tabId: string]; result: boolean };
  'browser:reload-tab': { args: [payload: { tabId: string; ignoreCache?: boolean }]; result: boolean };
  'browser:set-bounds': { args: [bounds: Rect]; result: void };
  'browser:set-pane-bounds': {
    // `scale` (optional) is the canvas zoom; web views render their page at it so
    // content scales with the canvas. Omitted by the classic split grid.
    args: [payload: { panes: { tabId: string; rect: Rect }[]; scale?: number }];
    result: void;
  };
  'browser:clear-pane-bounds': { args: []; result: void };
  'browser:set-inspect-mode': { args: [on: boolean]; result: void };
  'browser:set-visible': { args: [visible: boolean]; result: void };
  // A screen-px rect a renderer overlay (on-canvas context menu) covers; web views
  // intersecting it hide so the overlay isn't drawn behind a page. null clears it.
  // Precise — only the actually-covered cards blink, not every web card.
  'browser:set-occluder': { args: [rect: Rect | null]; result: void };
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
  // Capture the active web view as a PNG data URL (for the session receipt's
  // running-app snapshot), or null when there's no web view / capture is empty.
  'browser:capture-page-data': { args: []; result: { dataUrl: string } | null };
  // Floating in-page stage toolbar (§3.2): toggle on/off, returns the new state.
  'browser:stage-toolbar': { args: [on: boolean]; result: boolean };
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
        /** For a `terminal` tab: the PTY command profile (chat CLI v2 §6.1). */
        terminalProfile?: 'agent-cli';
        /** For a `devtools` tab: the web tab id this DevTools surface inspects. */
        devtoolsTargetTabId?: string;
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
  // Drag-reorder one tab to the slot of `targetId`, with Chrome-style tab-group
  // membership semantics (dropping inside a group's span joins it; dragging a
  // member out of its span leaves it). The strip's drag-drop uses this; the
  // bulk `tabs-reorder` above stays membership-neutral.
  'browser:tabs-move': {
    args: [payload: { id: string; targetId: string }];
    result: boolean;
  };
  // Pin/unpin a tab (favicon-only, kept at the front). Main re-sorts pinned-first.
  'browser:tabs-set-pinned': {
    args: [payload: { id: string; pinned: boolean }];
    result: boolean;
  };
  // Tab groups (Chrome-style; shared/browser.ts TabGroup). Main owns the group
  // records next to the tab records; every mutation pushes a fresh snapshot
  // through `browser:tabs-state`, so the renderer store stays a mirror.
  // Create a new group containing exactly the given tab; returns its id.
  'browser:tab-groups-create': {
    args: [payload: { tabId: string; name?: string; color?: TabGroupColor }];
    result: string | null;
  };
  'browser:tab-groups-add-tab': {
    args: [payload: { tabId: string; groupId: string }];
    result: boolean;
  };
  'browser:tab-groups-remove-tab': {
    args: [payload: { tabId: string }];
    result: boolean;
  };
  // Rename and/or recolor a group ('' name = unnamed, renders the dot only).
  'browser:tab-groups-update': {
    args: [payload: { groupId: string; name?: string; color?: TabGroupColor }];
    result: boolean;
  };
  // Collapse/expand. Refused (false) when collapsing would leave the workspace
  // with no visible tab to activate.
  'browser:tab-groups-collapse': {
    args: [payload: { groupId: string; collapsed: boolean }];
    result: boolean;
  };
  // Ungroup all members (tabs stay open); the group record is deleted.
  'browser:tab-groups-dissolve': {
    args: [payload: { groupId: string }];
    result: boolean;
  };
  // Close every member tab, then the group itself.
  'browser:tab-groups-close': {
    args: [payload: { groupId: string }];
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
  // Flat file list for a root, optionally INCLUDING git-ignored/dotfile entries
  // (the Explorer's "show ignored" toggle). Read-only; never mutates the cached
  // summary, so search/mentions keep their curated view.
  'workspace:list-files': {
    args: [payload: { root: string; includeIgnored: boolean }];
    result: FileEntry[];
  };
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
  // Pinned (TOFU) host keys — Settings → Remote lists them and clears one when
  // a host's key legitimately changed (reinstall). Fingerprints only, no secrets.
  'ssh:list-host-keys': { args: []; result: SshPinnedHostKey[] };
  'ssh:clear-host-key': {
    args: [payload: { host: string; port: number }];
    result: { ok: boolean };
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
  // Editor diff gutter: line ranges added/modified/deleted vs HEAD for one file.
  // `file` (a multi-root WorkspaceFileRef) resolves the owning root; omitted =
  // the active legacy workspace root. Never throws for non-repo/untracked —
  // returns { tracked: false } so the gutter quietly shows nothing.
  'git:file-diff-lines': {
    args: [payload: { path: string; file?: WorkspaceFileRef }];
    result: GitFileDiffLines;
  };
  // Editor inline blame: per-line {author, time, summary, hash} from
  // `git blame --line-porcelain`. Same root resolution + graceful degradation
  // as git:file-diff-lines ({ ok: false } instead of throwing).
  'git:blame-file': {
    args: [payload: { path: string; file?: WorkspaceFileRef }];
    result: GitBlameFile;
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
  // Stash. `list` returns [] for a non-repo; `push` stashes the working tree
  // including untracked files (-u) with an optional message; apply/pop/drop
  // take a "stash@{N}" ref (validated in main — never shell-parsed).
  'git:stash-list': { args: []; result: GitStashEntry[] };
  'git:stash-push': {
    args: [payload: { message?: string }];
    result: { ok: true };
  };
  'git:stash-apply': { args: [payload: { ref: string }]; result: { ok: true } };
  'git:stash-pop': { args: [payload: { ref: string }]; result: { ok: true } };
  'git:stash-drop': { args: [payload: { ref: string }]; result: { ok: true } };
  // Merge-conflict flow. `state` detects the in-progress operation from the
  // .git dir (never throws — { op: null } when clean/undeterminable);
  // `resolve` accepts one side of a conflicted file (checkout --ours/--theirs
  // + add); continue/abort drive the detected operation (`-c core.editor=true`
  // so no editor can hang the continue).
  'git:conflict-state': { args: []; result: GitConflictState };
  'git:conflict-resolve': {
    args: [payload: { path: string; side: 'ours' | 'theirs' }];
    result: { ok: true };
  };
  'git:conflict-continue': { args: []; result: { ok: true } };
  'git:conflict-abort': { args: []; result: { ok: true } };
  // Worktree isolation (Stage 12-B): run the agent in an isolated worktree.
  'git:worktree-status': { args: []; result: WorktreeIsolationStatus };
  'git:worktree-enter': { args: []; result: WorktreeIsolationStatus };
  'git:worktree-merge': { args: []; result: WorktreeMergeResult };
  'git:worktree-discard': { args: []; result: { ok: true } };
  // Lanes board: every worktree of the active repo + its pending-change count.
  'git:worktree-list': { args: []; result: WorktreeLane[] };
  // Lanes board cleanup: discard a stale agent worktree (refuses main / non-agent).
  'git:worktree-remove': {
    args: [payload: { path: string }];
    result:
      | { ok: true }
      | { ok: false; reason: 'no-repo' | 'not-found' | 'is-main' | 'not-agent' | 'error'; message?: string };
  };
  // Lanes board: merge an agent lane back into the base branch (then clean up).
  'git:worktree-merge-lane': { args: [payload: { path: string }]; result: WorktreeMergeResult };
  // Lanes board: push an agent lane + open its GitHub compare/create-PR page.
  'git:worktree-open-pr': {
    args: [payload: { path: string }];
    result:
      | { ok: true; url: string; pushed: boolean }
      | { ok: false; reason: 'no-repo' | 'not-a-lane' | 'no-remote' | 'not-github' };
  };

  // automations (Stage 12-C — scheduled saved-prompt agent runs)
  'automations:list': { args: []; result: Automation[] };
  'automations:create': { args: [input: AutomationInput]; result: Automation };
  'automations:update': { args: [payload: { id: string; input: AutomationInput }]; result: Automation | null };
  'automations:delete': { args: [payload: { id: string }]; result: { ok: boolean } };
  'automations:set-enabled': { args: [payload: { id: string; enabled: boolean }]; result: Automation | null };
  'automations:run-now': { args: [payload: { id: string }]; result: AutomationRun | null };

  // cached browser workflows (§3.10 — saved page-action sequences, model-free replay)
  'workflows:list': { args: []; result: Workflow[] };
  'workflows:save': { args: [payload: { name: string; steps: WorkflowStep[] }]; result: Workflow };
  'workflows:delete': { args: [payload: { id: string }]; result: boolean };
  'workflows:run': { args: [payload: { id: string }]; result: WorkflowRunResult };

  // spec lifecycle (§3.10 — per-workspace spec docs + task lists)
  'specs:list': { args: []; result: Spec[] };
  'specs:save': { args: [input: SpecInput]; result: Spec };
  /** AI Work OS: decompose a goal into a Task graph (null when no provider/error). */
  'workos:decompose': { args: [goal: string]; result: { ok: true; graph: WorkGraph } | { ok: false; reason: string } };
  /** AI Work OS: run one task as a real agent against the active workspace. */
  'workos:run-task': { args: [input: RunTaskInput]; result: RunTaskResult };
  /** AI Work OS: implement one task write-capably in an isolated worktree → diff. */
  'workos:implement-task': { args: [input: RunTaskInput]; result: ImplementTaskResult };
  /** AI Work OS: apply a task's reviewed worktree diff to the live workspace. */
  'workos:apply-patch': { args: [input: ApplyPatchInput]; result: ApplyPatchResult };
  'specs:delete': { args: [payload: { id: string }]; result: boolean };

  // per-lane dev server (§3.8 Mission Control)
  'lanes-dev:list': { args: []; result: LaneDevState[] };
  'lanes-dev:start': { args: [payload: { path: string }]; result: LaneDevStartResult };
  'lanes-dev:stop': { args: [payload: { path: string }]; result: boolean };
  'lanes-dev:open': { args: [payload: { path: string }]; result: boolean };
  // Per-lane GitHub PR/CI status (§3.8) — cached per branch; `force` bypasses
  // the TTL for the board's manual refresh.
  'lanes-github:status': {
    args: [payload: { force?: boolean }];
    result: LaneGithubStatusResult;
  };

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
  // history (library panel): full search (most recent 500 matching, empty
  // query = everything), per-entry delete by exact URL, and clear-all.
  'history:list': { args: [payload: { query?: string }]; result: HistoryEntry[] };
  'history:delete': { args: [payload: { url: string }]; result: boolean };
  'history:clear': { args: []; result: void };

  // bookmarks (electron/browser/bookmarks.ts). Mutations resolve the fresh
  // list so the caller reprojects without a follow-up fetch; the
  // browser:bookmarks push covers every other listener.
  'bookmarks:list': { args: []; result: BookmarkEntry[] };
  'bookmarks:add': { args: [input: BookmarkInput]; result: BookmarkEntry[] };
  'bookmarks:remove': { args: [payload: { id: string }]; result: BookmarkEntry[] };
  'bookmarks:update': {
    args: [payload: { id: string; title: string }];
    result: BookmarkEntry[];
  };

  // address-bar dropdown suggestions: matching bookmarks + history (frecency)
  // + a trailing "search the web" row. Matching/ranking runs in main where the
  // stores live (electron/suggest.ts → the pure ranker in shared/suggest.ts).
  'browser:suggest': { args: [query: string]; result: Suggestion[] };

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
    // `model` (optional) tests the model the user actually has selected for this
    // provider instead of the catalog default — so a key scoped to e.g. gpt-4.1
    // isn't failed by probing gpt-5. Falls back to the default when omitted.
    args: [provider: ProviderId, model?: string];
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
  // `opened` — whether the OS actually opened the browser; false tells the
  // renderer to lead with the manual link/copy affordances instead.
  'auth:oauth-start': {
    args: [provider: ProviderId];
    result: { flow: OAuthFlow; url: string; opened: boolean };
  };
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
  'agent:accept-edit': {
    args: [payload: { editId: string; workspaceId?: WorkspaceId }];
    result: AgentEditActionResult;
  };
  'agent:revert-edit': {
    args: [payload: { editId: string; workspaceId?: WorkspaceId }];
    result: AgentEditActionResult;
  };
  // Restore the live page to where it was when a turn started (runtime-aware
  // rollback): re-navigate the web tab to the turn's start URL if the agent moved
  // it. Pairs with "Revert all" (which restores the turn's file edits).
  'agent:restore-turn-page': { args: [payload: { turnId: string }]; result: { navigated: boolean } };
  // Roll the whole working tree back to a turn's start (§3.6 checkpoint). Safe:
  // current work is parked on the git stash stack first, never destroyed.
  'agent:restore-checkpoint': { args: [payload: { turnId: string }]; result: CheckpointRestore };
  // Built-in tool catalog for the Settings tool-groups UI (§3.11), grouped + gated
  // in the renderer via agent.denyTools.
  'agent:list-tools': { args: []; result: AgentToolInfo[] };
  // User-initiated cancel of a running background agent from the tray (audit H6).
  'agent:cancel-background': { args: [payload: { id: string }]; result: boolean };
  // Steerable plan (v6 §U5): user toggles a step's status, renames or removes it,
  // or inserts a person-authored step (`add`) that survives the model's replace.
  'agent:edit-plan-step': {
    args: [
      payload: {
        id?: string;
        status?: string;
        remove?: boolean;
        title?: string;
        add?: { title: string; after?: string };
      },
    ];
    result: boolean;
  };
  // Pull the current chat state (initial render / re-mount). `threadId` pulls a
  // specific thread (canvas cards); omitted ⇒ the workspace's active thread.
  'agent:snapshot': {
    args: [payload?: { workspaceId?: WorkspaceId; threadId?: string }];
    result: AgentChatState;
  };
  // Start a fresh conversation (clears transcript; keeps still-applied edits).
  'agent:reset': { args: [payload?: { workspaceId?: WorkspaceId }]; result: boolean };
  // Compact the conversation: summarize the transcript for the model while
  // keeping the visible scrollback (claude-code / codex `/compact`). An optional
  // `focus` (from `/compact <focus>`) asks the summarizer to preserve specific
  // details. Returns ok, or a reason when there's nothing to compact.
  'agent:compact': {
    args: [payload?: { focus?: string; workspaceId?: WorkspaceId }];
    result: { ok: boolean; reason?: string };
  };
  // Session history (v3 §5-C): list past saved conversations, resume one as the
  // active chat, or delete one. The list backs the sessions UI; resume swaps state.
  'agent:list-sessions': { args: [payload?: { workspaceId?: WorkspaceId }]; result: SessionSummary[] };
  'agent:search-sessions': {
    args: [payload: { query: string; workspaceId?: WorkspaceId }];
    result: SessionSearchHit[];
  };
  'agent:resume-session': { args: [payload: { id: string; workspaceId?: WorkspaceId }]; result: boolean };
  'agent:delete-session': { args: [payload: { id: string; workspaceId?: WorkspaceId }]; result: boolean };
  // threads (Stage 12-B-2 — concurrent conversation switching)
  'agent:list-threads': { args: [payload?: { workspaceId?: WorkspaceId }]; result: ThreadSummary[] };
  'agent:new-thread': { args: [payload?: { workspaceId?: WorkspaceId }]; result: ThreadSummary[] };
  'agent:switch-thread': { args: [payload: { id: string; workspaceId?: WorkspaceId }]; result: ThreadSummary[] };
  'agent:close-thread': { args: [payload: { id: string; workspaceId?: WorkspaceId }]; result: ThreadSummary[] };

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
  // Wipe every remembered note (the panel's clear-all). Returns the count removed.
  'memory:clear': { args: []; result: number };

  // context (built-in MCP mirror): the renderer pushes the surfaces main can't
  // see (unsaved editor buffers + explorer tree state) on change. Fire-and-forget
  // (result void) — main caches it for the read_editor / read_explorer tools.
  'context:sync': { args: [payload: ContextSyncPayload]; result: void };

  // external (stdio) MCP connectors (docs/context-mcp-design §8). The
  // Settings UI lists per-server status, reloads from the config file, toggles a
  // server's enabled flag, and reveals the config file for hand-editing. Each
  // mutation returns the fresh statuses so the renderer reprojects without a
  // follow-up fetch.
  'mcp:list-servers': { args: []; result: McpServerStatus[] };
  'mcp:reload': { args: []; result: McpServerStatus[] };
  'mcp:config-diagnostics': { args: []; result: McpConfigHealth };
  'mcp:set-enabled': {
    args: [payload: { id: string; enabled: boolean }];
    result: McpServerStatus[];
  };
  'mcp:update-server': {
    args: [
      payload: {
        id: string;
        enabled?: boolean;
        trust?: boolean;
        disabledTools?: string[];
        autoApproveTools?: string[];
        confirmTools?: string[];
      },
    ];
    result: McpServerStatus[];
  };
  'mcp:remove-server': {
    args: [payload: { id: string }];
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
  'plugins:install-folder': { args: []; result: PluginStatus[] };
  'plugins:commands': { args: []; result: PluginCommandSnapshot[] };
  'plugins:open-folder': { args: []; result: { path: string } };
  'plugins:remove': {
    args: [payload: { id: string }];
    result: PluginStatus[];
  };

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

  // `marudesk` terminal command shim (Settings → Terminal — electron/cli-command.ts)
  'cli:command-status': { args: []; result: CliCommandStatus };
  'cli:command-install': { args: []; result: CliCommandStatus };
  'terminal:ready': { args: [payload: { id: string }]; result: void };
  // Always-on terminal error capture (terminal "Fix this"): drain the per-PTY
  // ring of detected error events — the badge popover reads this on open. The
  // live count pushes on the `terminal:error-count` event. Empty array when the
  // session is gone. `clear-errors` empties the ring (and re-pushes count 0).
  'terminal:pull-errors': {
    args: [payload: { id: string }];
    result: TerminalErrorEvent[];
  };
  'terminal:clear-errors': { args: [payload: { id: string }]; result: void };

  // usage monitoring (electron/usage/index.ts)
  'usage:fetch': { args: [provider: ProviderId]; result: UsageReport | null };
  'usage:fetch-all': { args: []; result: UsageReport[] };

  // Multi-credential OAuth slot management (electron/oauth/handlers.ts)
  'auth:oauth-slots': { args: [provider: ProviderId]; result: { count: number; activeScope?: string } };
  'auth:oauth-add-slot': { args: [provider: ProviderId]; result: { flow: OAuthFlow; url: string; opened: boolean; userCode?: string; verificationUri?: string } };
  'auth:oauth-rotate': { args: [provider: ProviderId]; result: boolean };

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
