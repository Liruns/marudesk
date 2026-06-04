# Multi-Workspace Deck

## TL;DR
> **Summary**: Promote MaruDesk from a single-folder workspace into multiple named workspace screens, each with multiple folder roots, its own tab set, and its own inner tab split/grid; add outer workspace split panes, focus-following Explorer, pane-local Peek Explorer, and workspace-aware MCP context.
> **Deliverables**: multi-root workspace model; workspace-scoped tabs/layouts; workspace split UI; Peek Explorer; workspace-aware editor/search/git/patch/MCP paths; Playwright/visual/screenshot coverage; commit/PR/merge; `0.0.2` release with package artifacts.
> **Effort**: XL
> **Parallel**: YES - 5 waves
> **Critical Path**: shared workspace/root schema -> main workspace registry + IPC -> tab/workspace ownership -> outer workspace layout -> Explorer/Peek/MCP -> QA/release.

## Context
### Original Request
The user approved the latest multi-workspace split concept and asked to plan, review the plan, implement, commit, review the commit, recommit fixes, run visual/e2e/Playwright/screenshot QA, open/review/merge a PR, then cut `0.0.2` with attached release files.

### Interview Summary
- Workspace is a named work screen, not one folder.
- Each workspace can contain multiple folder roots such as `FE` and `BE`.
- Each workspace owns its tabs and remembered tab split layout.
- Workspaces themselves can be split side-by-side.
- A tab split remains a lower-level split inside one workspace pane.
- The left Explorer follows the focused workspace pane.
- Other workspace panes expose file access through a pane-local Peek Explorer popover.
- Avoid a permanent two-line top tab bar.

### Metis Review (gaps addressed)
- Canonical ids are fixed: `workspaceId`, `workspacePaneId`, `rootId`, `tabId`.
- Every file operation resolves inside exactly one `rootId`; there is no synthetic combined filesystem root.
- Editor buffers use root-qualified document keys.
- Focus events are defined: startup restore, workspace switch, workspace pane click, local tab activation, keyboard pane focus.
- Peek Explorer MVP is browse/open/select only. Destructive file actions remain in the main Explorer.
- MCP defaults to the focused workspace pane/root when selectors are omitted.
- MCP visible context is the active outer workspace layout's visible panes; hidden tabs are listable but not visible pane context.
- Release work assumes GitHub because the only remote is `origin=https://github.com/Liruns/marudesk.git`.

## Work Objectives
### Core Objective
Build a polished MaruDesk workspace deck where multiple multi-root workspaces can be opened, split, and operated independently while preserving the existing tab and tab-split experience inside each workspace.

### Deliverables
- `marudesk/shared/workspace.ts`: multi-root workspace contracts and root-qualified file refs.
- `marudesk/electron/workspace.ts`: workspace registry instead of `currentWorkspace` singleton.
- New workspace-level IPC channels under `workspaces:*`; legacy `workspace:*` channels remain as active-pane/focused-root compatibility wrappers.
- `TabRecord` / `TabState` carry `workspaceId`; renderer tab strip shows the focused workspace's tabs.
- New renderer workspace deck store and outer workspace pane layout.
- Focus-following Explorer plus workspace map.
- Pane-local Peek Explorer.
- Workspace-aware editor document keys, terminal cwd, search/git/patch/file tools, and MCP context tools.
- Playwright tests and screenshot harness additions.
- Docs/README/changelog/version update for `0.0.2`.
- GitHub PR merged and GitHub release `v0.0.2` with packaged artifacts attached.

### Definition of Done
- `cd marudesk && npm run typecheck` exits 0.
- `cd marudesk && npm run build` exits 0.
- `cd marudesk && npm run harness:mcp` exits 0.
- `cd marudesk && npm run e2e` exits 0.
- `cd marudesk && npx playwright test e2e/screens.spec.ts e2e/multi-workspace.spec.ts` exits 0 and writes screenshots under `marudesk/.screens/`.
- At least one real screenshot proves workspace split + per-workspace tab strips + Peek Explorer.
- Git branch is pushed, PR is opened, reviewed, updated if needed, merged.
- `marudesk/package.json`, `marudesk/package-lock.json`, and root `CHANGELOG.md` reflect `0.0.2`.
- Desktop package artifacts are built and attached to release `v0.0.2`.

### Must Have
- Multiple folder roots per workspace with user-facing labels (`FE`, `BE`, etc.).
- Multiple workspace screens.
- Workspace split panes.
- Per-workspace tabs.
- Existing tab split/grid inside a workspace pane.
- Focus-following main Explorer.
- Pane-local Peek Explorer.
- Root-qualified paths everywhere ambiguous.
- MCP can list/read workspaces, roots, tabs, explorer state, editor buffers, and files across visible workspace panes.

### Must NOT Have
- No permanent two-row top tab bar.
- No duplicated full-size file trees for every workspace pane by default.
- No hard-coded JSX colors; follow `marudesk/DESIGN.md`.
- No changes to unrelated `mobile/` dirty worktree files.
- No weakening/removing existing tests.
- No file operation may escape the selected root.

## Canonical Implementation Decisions
### Identity Model
- Canonical ids are `WorkspaceId`, `WorkspacePaneId`, `WorkspaceRootId`, and `TabId`.
- Every tab has `workspaceId`; there are no floating globally visible tabs.
- `SYSTEM_WORKSPACE_ID = 'system'` is a startup/internal workspace with no folder roots. It is used only when no user workspace exists yet, or when the user explicitly opens system surfaces there.
- New tabs default to the focused workspace pane's `workspaceId`. Settings/home/agent tabs opened from a user workspace belong to that workspace unless explicitly opened in the system workspace.
- File identity is `WorkspaceFileRef = { workspaceId; rootId; path }`, where `path` is POSIX root-relative.
- Editor document keys are `${workspaceId}:${rootId}:${path}`. The display label is `Root / path` inside a workspace and `Workspace / Root / path` across workspaces.

### Workspace IPC Contract
- Keep legacy `workspace:*` channels as compatibility wrappers over the focused workspace/root.
- Add plural workspace registry channels to `IpcMap`:
  ```ts
  'workspaces:list': { args: []; result: WorkspaceSnapshot };
  'workspaces:create': {
    args: [payload: { name: string; roots: Array<{ name: string; path: string }> }];
    result: WorkspaceRecord;
  };
  'workspaces:add-root': {
    args: [payload: { workspaceId: WorkspaceId; name: string; path: string }];
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
  'workspaces:set-active': {
    args: [payload: { workspaceId: WorkspaceId; paneId?: WorkspacePaneId }];
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
    result: SaveAsResult & { file: WorkspaceFileRef };
  };
  'workspaces:rank': {
    args: [payload: { workspaceId: WorkspaceId; rootId?: WorkspaceRootId; capture: CaptureInput }];
    result: RankedFile[];
  };
  ```
- `workspace:create/rename/delete/move/copy/reveal` remain file-mutation channels. They resolve only through the focused workspace/root and must not be confused with `workspaces:create`.

### Browser View Bounds
- A single top-level `WorkspaceStage` owns reporting of native browser pane bounds.
- Inner tab grid components become measured layout components when nested under workspace panes; they report visible web-tab rects upward instead of independently calling `browser:set-pane-bounds`.
- `WorkspaceStage` flattens all visible web-tab rects from all visible workspace panes into one `browser:set-pane-bounds` call.
- `browser:clear-pane-bounds` is called only when the whole workspace stage unmounts or when no web-tab pane is visible. Individual workspace pane changes recompute and send the flattened set.

### Editor Tab Binding
- Extend `TabRecord` and `TabState` with `editorFile?: WorkspaceFileRef`.
- Keep `filePath?: string` as a deprecated display/legacy migration field during the transition. New editor store logic uses `editorFile`, not `filePath`, as the source of truth.
- `browser:tabs-bind-path` becomes `browser:tabs-bind-file` for root-qualified binding; legacy `browser:tabs-bind-path` wraps the focused root.
- Duplicate relative paths are supported because editor buffers are keyed by workspace/root/path.

### Search, Git, Patch, Terminal
- Add root-aware git read channels:
  ```ts
  'git:status-root': {
    args: [payload: { workspaceId: WorkspaceId; rootId: WorkspaceRootId }];
    result: GitStatus;
  };
  'git:status-workspace': {
    args: [payload: { workspaceId: WorkspaceId }];
    result: { workspaceId: WorkspaceId; roots: Array<{ rootId: WorkspaceRootId; name: string; status: GitStatus }> };
  };
  ```
- Source Control renders a root selector and shows one root detail at a time. There is no combined multi-root git command.
- Add `search:workspace-content` with `{ workspaceId, rootId?, query, opts }`; omitted `rootId` searches all roots in the selected workspace and returns root-qualified paths.
- Legacy `git:*`, `search:content`, patch, terminal, and workspace mutation channels resolve to the focused workspace/root unless explicitly replaced by a root-qualified channel.

### Test And Release Policy
- No test-only IPC backdoor is allowed for the feature. Playwright creates temp directories, then uses public `workspaces:*` channels through the app bridge.
- Release upload attaches only package artifacts produced under `marudesk/release/`: `*.exe`, `*.blockmap`, and `latest.yml`. Exclude `builder-debug.yml` and logs.

## Verification Strategy
> ZERO HUMAN INTERVENTION - all verification is agent-executed after implementation.
- Test decision: tests-after with focused Playwright/Electron and MCP harness coverage.
- QA policy: every implementation task includes agent-executed happy and failure/edge scenarios.
- Evidence: screenshots under `marudesk/.screens/`; command logs summarized in final; PR/release URLs inspected.

## Execution Strategy
### Parallel Execution Waves
Wave 1: Shared schema, main registry, renderer store scaffolding, test fixtures.
Wave 2: Tab/workspace ownership, editor/root-qualified keys, Explorer extraction.
Wave 3: Workspace pane layout, Peek Explorer, workspaces UI, browser bounds routing.
Wave 4: Search/git/patch/terminal/MCP integration and docs.
Wave 5: Full QA, review, commit/PR/release.

### Dependency Matrix
- T1 blocks T2, T3, T4, T5, T8, T10, T11.
- T2 blocks T3, T5, T8, T9, T10.
- T3 blocks T4, T6, T7, T9.
- T4 blocks T6 and T7.
- T5 blocks T8 and T10.
- T6 blocks T7 and visual QA.
- T8 blocks T10 and `harness:mcp`.
- T9 blocks persistence e2e.
- T10 blocks final e2e.
- T11/T12 block commit/PR/release.

## TODOs
- [ ] 1. Define Multi-Root Workspace Contracts

  **What to do**: Update shared contracts so a workspace is a named record with roots and stable ids. Add `WorkspaceId`, `WorkspacePaneId`, `WorkspaceRootId`, `WorkspaceRootSummary`, `WorkspaceRecord`, `WorkspaceSnapshot`, `WorkspaceFileRef`, and display helpers for `Project / Root / path`.
  **Must NOT do**: Remove legacy `WorkspaceSummary`; keep it as a compatibility shape where existing code still needs it during migration.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: T2,T3,T4,T5,T8,T10 | Blocked By: none

  **References**:
  - Pattern: `marudesk/shared/workspace.ts:6` - current single-root `WorkspaceSummary`.
  - Pattern: `marudesk/shared/browser.ts:65` - shared tab state style.
  - Pattern: `marudesk/shared/ipc.ts:202` - IPC channel grouping pattern.

  **Acceptance Criteria**:
  - [ ] `WorkspaceFileRef` contains `workspaceId`, `rootId`, and root-relative `path`.
  - [ ] Contracts describe root labels and root summaries without a combined root path.
  - [ ] `npm run typecheck` catches missing root selectors in newly typed channels.

  **QA Scenarios**:
  ```
  Scenario: Contract compile
    Tool: bash
    Steps: cd marudesk && npm run typecheck
    Expected: exits 0 after all implementation tasks.
    Evidence: command summary

  Scenario: Duplicate relative path display
    Tool: playwright
    Steps: create Project A with FE/src/App.tsx and BE/src/App.tsx; open both.
    Expected: UI labels show FE / src/App.tsx and BE / src/App.tsx.
    Evidence: marudesk/.screens/multi-workspace-paths.png
  ```

  **Commit**: YES | Message: `feat(workspace): add multi-root workspace contracts` | Files: `marudesk/shared/workspace.ts`, `marudesk/shared/ipc.ts`

- [ ] 2. Replace Singleton Workspace Backend With Registry

  **What to do**: Refactor `electron/workspace.ts` around a registry of `WorkspaceRecord`s. Add the exact plural IPC channels defined in "Workspace IPC Contract": `workspaces:list/create/add-root/remove-root/set-active/rename/reindex/read-file/write-file/save-as/rank`. Preserve legacy `workspace:open/list/read-file/write-file/save-as/rank` by resolving through the active workspace pane and focused root.
  **Must NOT do**: Let a path resolve across multiple roots or fallback to another root when a file is missing.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: T3,T5,T8,T10 | Blocked By: T1

  **References**:
  - Pattern: `marudesk/electron/workspace.ts:44` - current singleton to replace.
  - Pattern: `marudesk/electron/workspace.ts:477` - current workspace IPC handlers.
  - Pattern: `marudesk/electron/ipc/define-handler.ts:29` - `requireWorkspace()` guard to extend.
  - Pattern: `marudesk/electron/fs-safe.ts` - root containment helpers must remain the safety boundary.

  **Acceptance Criteria**:
  - [ ] Two workspaces can exist simultaneously in main state.
  - [ ] One workspace can contain at least two roots.
  - [ ] Root-qualified read/write rejects paths outside that root.
  - [ ] Legacy single-root IPC still works against focused root.

  **QA Scenarios**:
  ```
  Scenario: Multi-root registry
    Tool: playwright
    Steps: use public workspaces:create IPC to create Project A with FE+BE temp dirs and Project B with FE+BE temp dirs.
    Expected: workspaces:list returns both records with two roots each.
    Evidence: e2e/multi-workspace.spec.ts

  Scenario: Root escape rejected
    Tool: playwright
    Steps: call root-qualified read with path ../outside.txt.
    Expected: call rejects with marudesk path validation error.
    Evidence: e2e/multi-workspace.spec.ts
  ```

  **Commit**: YES | Message: `feat(workspace): manage multiple workspace records` | Files: `marudesk/electron/workspace.ts`, `marudesk/electron/ipc/define-handler.ts`, `marudesk/shared/ipc.ts`

- [ ] 3. Scope Tabs To Workspaces

  **What to do**: Add `workspaceId` to main `TabRecord` and shared `TabState`. Update tab creation, activation, close, reopen, reorder, pinning, restore, and snapshots so each workspace has a last active tab. Renderer `useTabsStore` keeps all tabs but exposes focused-workspace selectors/actions for the strip.
  **Must NOT do**: Destroy existing global tab ids or break feature tab rendering.

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: T4,T6,T7,T9 | Blocked By: T1,T2

  **References**:
  - Pattern: `marudesk/electron/browser/state.ts:23` - current `TabRecord`.
  - Pattern: `marudesk/electron/browser/state.ts:83` - global tab map.
  - Pattern: `marudesk/electron/browser/tabs.ts:65` - tab creation.
  - Pattern: `marudesk/src/features/tabs/store.ts` - renderer tab store.
  - Pattern: `marudesk/electron/browser/tab-session.ts` - current session restore.

  **Acceptance Criteria**:
  - [ ] Creating a tab in Project A does not show it in Project B's local tab strip.
  - [ ] Switching back to Project A restores its last active tab.
  - [ ] System surfaces use `SYSTEM_WORKSPACE_ID = 'system'` only when no user workspace exists or the user explicitly opens that system workspace; otherwise they belong to the focused workspace.

  **QA Scenarios**:
  ```
  Scenario: Per-workspace tab strips
    Tool: playwright
    Steps: create Project A and Project B; open AI Chat + editor in A, browser in B; switch workspaces.
    Expected: each strip shows only its workspace tabs.
    Evidence: marudesk/.screens/multi-workspace-tabs.png

  Scenario: Last active tab restore
    Tool: playwright
    Steps: activate Project A App tab, switch to Project B, switch back.
    Expected: App tab is active again.
    Evidence: e2e/multi-workspace.spec.ts
  ```

  **Commit**: YES | Message: `feat(tabs): partition tabs by workspace` | Files: `marudesk/electron/browser/*`, `marudesk/shared/browser.ts`, `marudesk/src/features/tabs/*`

- [ ] 4. Introduce Workspace Deck Store And Outer Split Layout

  **What to do**: Add renderer feature `src/features/workspaces/` with a workspace deck store, pure outer layout helpers, focused pane state, workspace pane actions, and keyboard-safe focus updates. Use existing tab `layout.ts` concepts but keep workspace layout separate from tab grid layout.
  **Must NOT do**: Reuse `useGridStore` directly for workspace panes; that store is tab-level and would blur hierarchy.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: T6,T7 | Blocked By: T1,T2,T3

  **References**:
  - Pattern: `marudesk/src/features/tabs/layout.ts:1` - pure split layout mechanics to mirror without reusing tab-grid state.
  - Pattern: `marudesk/src/features/tabs/grid.ts:164` - Zustand layout store pattern.
  - Pattern: `marudesk/src/views/Shell.tsx:91` - top-level feature mounting point.

  **Acceptance Criteria**:
  - [ ] Store supports one active workspace and a two-pane workspace split.
  - [ ] Focused workspace pane is updated by pane click, workspace switch, and tab activation.
  - [ ] Workspace split separator is visually distinct from tab split separator.

  **QA Scenarios**:
  ```
  Scenario: Workspace split
    Tool: playwright
    Steps: create two workspaces and split Project B to the right.
    Expected: two workspace panes are visible with distinct mastheads.
    Evidence: marudesk/.screens/workspace-split.png

  Scenario: Focus update
    Tool: playwright
    Steps: click Project B pane.
    Expected: focused pane marker moves to Project B and Explorer heading changes to Project B.
    Evidence: e2e/multi-workspace.spec.ts
  ```

  **Commit**: YES | Message: `feat(workspaces): add workspace deck layout store` | Files: `marudesk/src/features/workspaces/*`, `marudesk/src/views/Shell.tsx`

- [ ] 5. Root-Qualify Editor Buffers And File Opening

  **What to do**: Change editor document keys from relative path to `${workspaceId}:${rootId}:${path}`. Add helpers for converting `WorkspaceFileRef` to document keys and display labels. Extend tab metadata with `editorFile?: WorkspaceFileRef`, keep `filePath?: string` as deprecated legacy/display data, and update `openFile`, `ensureLoaded`, `save`, `saveUntitled`, dirty checks, tab close confirmation, Monaco model disposal, and tab binding.
  **Must NOT do**: Use plain `src/App.tsx` as a unique editor key.

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: T7,T8,T10 | Blocked By: T1,T2,T3

  **References**:
  - Pattern: `marudesk/src/features/editor/store.ts:19` - current path-keyed buffer map.
  - Pattern: `marudesk/src/features/editor/store.ts:67` - current `openFile` path flow.
  - Pattern: `marudesk/electron/browser/handlers.ts` `browser:tabs-bind-path` - editor tab rebinding.

  **Acceptance Criteria**:
  - [ ] FE and BE files with the same relative path can be open at the same time.
  - [ ] Saving one does not affect the other.
  - [ ] Dirty close confirmation names the root label.

  **QA Scenarios**:
  ```
  Scenario: Duplicate path open
    Tool: playwright
    Steps: open Project A FE/src/App.tsx and BE/src/App.tsx.
    Expected: two editor tabs exist with distinct root-qualified labels.
    Evidence: e2e/multi-workspace.spec.ts

  Scenario: Save isolation
    Tool: playwright
    Steps: edit FE/src/App.tsx, save, read both files from disk.
    Expected: FE changed; BE unchanged.
    Evidence: e2e/multi-workspace.spec.ts
  ```

  **Commit**: YES | Message: `feat(editor): key buffers by workspace root` | Files: `marudesk/src/features/editor/*`, `marudesk/electron/browser/*`, `marudesk/shared/browser.ts`

- [ ] 6. Build Workspace Pane Shell Without A Permanent Double Tab Bar

  **What to do**: Replace the single `Stage` mount in `Shell` with a workspace-aware stage. Normal mode renders one compact local strip `WorkspaceName [tabs...]`; split mode renders each workspace pane with masthead actions (`Quick Open`, `Peek Explorer`, menu) and local tab strip. Inner tab content uses existing `Stage`/`GridStage` logic scoped to that workspace's active tab.
  **Must NOT do**: Put a fixed workspace tab row above the existing tab strip.

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: T7,visual QA | Blocked By: T3,T4

  **References**:
  - Pattern: `marudesk/src/views/Shell.tsx:114` - current layout row.
  - Pattern: `marudesk/src/features/tabs/TabStrip.tsx` - existing strip behavior.
  - Pattern: `marudesk/src/features/tabs/Stage.tsx:30` - active tab/grid switch.
  - Design: `marudesk/DESIGN.md` - restrained dark IDE tokens.

  **Acceptance Criteria**:
  - [ ] Single-workspace mode has one top tab line.
  - [ ] Workspace split mode has pane-local mastheads and tab strips.
  - [ ] Existing tab split inside a workspace still works.
  - [ ] Active workspace pane has a subtle token-based outline; no hard-coded colors.

  **QA Scenarios**:
  ```
  Scenario: No double top bar
    Tool: playwright
    Steps: launch app with one workspace and inspect top chrome.
    Expected: only one local workspace/tab strip row is visible.
    Evidence: marudesk/.screens/workspace-single.png

  Scenario: Nested split hierarchy
    Tool: playwright
    Steps: split Project A | Project B, then tab-split two tabs inside Project A.
    Expected: workspace divider is outer and thicker; tab divider is inner and thinner.
    Evidence: marudesk/.screens/workspace-and-tab-split.png
  ```

  **Commit**: YES | Message: `feat(workspaces): render workspace pane shell` | Files: `marudesk/src/features/workspaces/*`, `marudesk/src/features/tabs/*`, `marudesk/src/views/Shell.tsx`

- [ ] 7. Add Focus-Following Explorer And Peek Explorer

  **What to do**: Extract reusable file-tree presentation from `ExplorerPanel`. Add a `WorkspaceMap` section listing workspaces and roots. Make the main Explorer follow the focused workspace pane. Add `PeekExplorer` popover in each workspace pane; it lists roots/files, supports search/filter, opens files in that pane's workspace, and closes on Escape/outside click. Destructive create/rename/delete/move/copy stay in the main Explorer.
  **Must NOT do**: Mount a full fixed Explorer for every workspace pane by default.

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: visual QA | Blocked By: T4,T5,T6

  **References**:
  - Pattern: `marudesk/src/features/workspace/ExplorerPanel.tsx` - current Explorer UI and resize behavior.
  - Pattern: `marudesk/src/features/workspace/FileTree.tsx` - current tree rows.
  - Pattern: `marudesk/src/features/workspace/store.ts:52` - expanded/selected singleton state to partition.
  - Icons: use Lucide `Search`, `PanelLeft`, `FolderTree`, `MoreHorizontal`.

  **Acceptance Criteria**:
  - [ ] Clicking Project B workspace pane changes main Explorer heading to Project B.
  - [ ] Peek Explorer opens inside Project B pane without changing main Explorer focus until a file is opened or pane is focused by click.
  - [ ] Peek Explorer can open `Project B / BE / src/server.ts` into Project B's local tab strip.
  - [ ] Main Explorer still supports existing file mutations for the focused workspace.

  **QA Scenarios**:
  ```
  Scenario: Focus-following Explorer
    Tool: playwright
    Steps: split Project A | Project B, click each pane.
    Expected: Explorer heading and tree roots follow the clicked pane.
    Evidence: e2e/multi-workspace.spec.ts

  Scenario: Peek Explorer open file
    Tool: playwright
    Steps: click Project B peek icon, choose BE/src/server.ts.
    Expected: Project B gets an editor tab; Project A tabs unchanged.
    Evidence: marudesk/.screens/peek-explorer.png
  ```

  **Commit**: YES | Message: `feat(workspaces): add peek explorer` | Files: `marudesk/src/features/workspace/*`, `marudesk/src/features/workspaces/*`

- [ ] 8. Make Agent MCP And Context Workspace-Aware

  **What to do**: Extend context mirror to include visible workspace panes, workspace/root ids, root-qualified editor buffers, and focused explorer state per workspace. Add MCP tools `list_workspaces`, `list_workspace_roots`, and update `list_tabs`, `read_editor`, `read_explorer`, `read_file`, `list_files`, `grep`, `edit_file`, `multi_edit` schemas to accept optional workspace/root selectors. Update `ToolContext` and system prompt.
  **Must NOT do**: Allow write tools to silently edit a non-focused workspace without the tool result naming the target workspace/root.

  **Parallelization**: Can Parallel: YES | Wave 4 | Blocks: T10,harness:mcp | Blocked By: T1,T2,T5,T7

  **References**:
  - Pattern: `marudesk/shared/context.ts:40` - current single mirror payload.
  - Pattern: `marudesk/src/features/agent/context-sync.ts:18` - renderer mirror builder.
  - Pattern: `marudesk/electron/agent/context-sources.ts:62` - current `list_tabs`.
  - Pattern: `marudesk/electron/agent/tools/executors.ts` - current file tool executors.
  - Pattern: `marudesk/electron/agent/loop.ts` - system prompt and `ToolContext` assembly.

  **Acceptance Criteria**:
  - [ ] MCP `list_workspaces` returns Project A and Project B with roots.
  - [ ] MCP `list_tabs({ workspaceId })` scopes tabs correctly.
  - [ ] MCP `read_editor({ workspaceId, rootId, path })` reads unsaved editor content for the selected root.
  - [ ] MCP write tool result includes `Project / Root / path`.

  **QA Scenarios**:
  ```
  Scenario: MCP reads visible workspace panes
    Tool: bash
    Steps: cd marudesk && npm run harness:mcp
    Expected: new assertions for list_workspaces/list_tabs/read_editor/read_explorer pass.
    Evidence: command summary

  Scenario: MCP default target
    Tool: playwright
    Steps: focus Project B pane and ask context mirror via test hook.
    Expected: omitted selectors resolve to Project B focused root.
    Evidence: e2e/multi-workspace.spec.ts
  ```

  **Commit**: YES | Message: `feat(agent): expose workspace deck context to MCP` | Files: `marudesk/shared/context.ts`, `marudesk/electron/agent/*`, `marudesk/src/features/agent/context-sync.ts`

- [ ] 9. Persist Workspaces, Roots, Tabs, And Layout

  **What to do**: Add versioned persistence for workspace records, roots, active/focused pane, outer workspace layout, per-workspace last active tab, tab session workspace ownership, and inner tab split groups. Migrate old single-root recents/session data into one default workspace.
  **Must NOT do**: Drop existing tab restore behavior for web/editor tabs.

  **Parallelization**: Can Parallel: YES | Wave 4 | Blocks: persistence e2e | Blocked By: T2,T3,T4

  **References**:
  - Pattern: `marudesk/electron/browser/tab-session.ts` - current tab persistence.
  - Pattern: `marudesk/src/features/workspace/store.ts:18` - localStorage recents.
  - Pattern: `marudesk/electron/settings.ts` - existing userData persistence style.

  **Acceptance Criteria**:
  - [ ] Restart restores workspace records and roots.
  - [ ] Restart restores each workspace's local tabs.
  - [ ] Restart restores active workspace pane and two-pane workspace split.
  - [ ] Existing single-root session migrates to a workspace with one root.

  **QA Scenarios**:
  ```
  Scenario: Persistence restore
    Tool: playwright
    Steps: launch with shared userData, create Project A/B, split them, open tabs, close, relaunch.
    Expected: Project A/B, roots, tabs, and split are restored.
    Evidence: e2e/multi-workspace.spec.ts

  Scenario: Legacy migration
    Tool: playwright
    Steps: seed legacy tab-session/workspace recent data, launch.
    Expected: default workspace with one root and restorable tabs.
    Evidence: e2e/multi-workspace.spec.ts
  ```

  **Commit**: YES | Message: `feat(workspaces): persist workspace deck state` | Files: `marudesk/electron/browser/tab-session.ts`, `marudesk/electron/workspace*.ts`, `marudesk/src/features/workspaces/*`

- [ ] 10. Update Search, Git, Patch, Terminal, And PC Source Boundaries

  **What to do**: Route search, git, patch, workspace mutations, terminal creation, and PC source open/reveal through workspace/root selectors. UI defaults use focused workspace/root. Add `git:status-root`, `git:status-workspace`, and `search:workspace-content` with the shapes defined in "Search, Git, Patch, Terminal". Search supports focused root and all roots in focused workspace. Git panel shows a root selector, per-root repository status, and selected root branch.
  **Must NOT do**: Run git across multiple roots in one command.

  **Parallelization**: Can Parallel: YES | Wave 4 | Blocks: full e2e | Blocked By: T1,T2,T5

  **References**:
  - Pattern: `marudesk/electron/git.ts:395` - current single-root git handlers.
  - Pattern: `marudesk/electron/search.ts:274` - current single-root search handler.
  - Pattern: `marudesk/electron/patch.ts:328` - current single-root patch preview/apply.
  - Pattern: `marudesk/electron/workspace-mutate.ts:197` - current single-root file mutations.
  - Pattern: `marudesk/electron/terminal.ts` - terminal cwd and session management.

  **Acceptance Criteria**:
  - [ ] Source Control can select FE or BE root and show that root's git state.
  - [ ] Search over focused workspace returns root-qualified paths.
  - [ ] Patch preview/apply edits the selected root only.
  - [ ] New terminal opens in selected root cwd.

  **QA Scenarios**:
  ```
  Scenario: Root-scoped search
    Tool: playwright
    Steps: create same search text in FE and BE, search all roots.
    Expected: results show FE/path and BE/path.
    Evidence: e2e/multi-workspace.spec.ts

  Scenario: Git root isolation
    Tool: playwright
    Steps: initialize git only in FE root, open Source Control on FE then BE.
    Expected: FE shows repo; BE offers initialize repository.
    Evidence: e2e/multi-workspace.spec.ts
  ```

  **Commit**: YES | Message: `feat(workspace): route tools by workspace root` | Files: `marudesk/electron/git.ts`, `marudesk/electron/search.ts`, `marudesk/electron/patch.ts`, `marudesk/electron/workspace-mutate.ts`, `marudesk/electron/terminal.ts`, `marudesk/src/features/git/*`, `marudesk/src/features/search/*`, `marudesk/src/features/terminal/*`

- [ ] 11. Add Multi-Workspace Playwright And Screenshot Coverage

  **What to do**: Add `marudesk/e2e/multi-workspace.spec.ts` with temp-root fixtures that drive the public `workspaces:*` IPC through the app bridge. Extend `screens.spec.ts` with workspace single, workspace split, nested tab split, and Peek Explorer screenshots.
  **Must NOT do**: Depend on the developer's real workspace or credentials.

  **Parallelization**: Can Parallel: YES | Wave 4 | Blocks: final QA | Blocked By: T6,T7,T8,T9,T10

  **References**:
  - Pattern: `marudesk/e2e/helpers/app.ts` - isolated Electron launcher.
  - Pattern: `marudesk/e2e/grid.spec.ts:10` - split drag testing.
  - Pattern: `marudesk/e2e/screens.spec.ts:21` - screenshot harness.

  **Acceptance Criteria**:
  - [ ] New spec covers multi-root creation, workspace split, focus-follow Explorer, Peek Explorer, tab partitioning, nested tab split, persistence, and root-qualified labels.
  - [ ] Screenshot harness writes at least four new workspace deck screenshots.

  **QA Scenarios**:
  ```
  Scenario: Multi-workspace e2e
    Tool: bash
    Steps: cd marudesk && npx playwright test e2e/multi-workspace.spec.ts
    Expected: exits 0.
    Evidence: command summary

  Scenario: Visual screenshot pass
    Tool: bash
    Steps: cd marudesk && npx playwright test e2e/screens.spec.ts
    Expected: exits 0 and writes workspace screenshots.
    Evidence: marudesk/.screens/workspace-split.png
  ```

  **Commit**: YES | Message: `test(workspaces): cover workspace deck flows` | Files: `marudesk/e2e/*`

- [ ] 12. Update Documentation, Version, And Release Notes

  **What to do**: Update root `README.md`, `marudesk/README.md`, and `marudesk/docs/roadmap.md` or a new design note to describe multi-root workspace deck behavior. Bump `marudesk/package.json` and `marudesk/package-lock.json` to `0.0.2`. Add `CHANGELOG.md` entry `0.0.2 - 2026-06-04`.
  **Must NOT do**: Claim mobile/relay behavior changed unless those packages were actually touched.

  **Parallelization**: Can Parallel: YES | Wave 4 | Blocks: release | Blocked By: implementation shape stable

  **References**:
  - Pattern: `README.md` feature sections for desktop capabilities.
  - Pattern: `marudesk/README.md` architecture notes.
  - Pattern: `CHANGELOG.md` existing `0.0.1 - 2026-06-04`.
  - Version: `marudesk/package.json:4`.

  **Acceptance Criteria**:
  - [ ] Docs explain Workspace = named screen with multiple roots.
  - [ ] Changelog lists user-facing multi-workspace features and QA summary.
  - [ ] Version files are `0.0.2`.

  **QA Scenarios**:
  ```
  Scenario: Version files
    Tool: bash
    Steps: cd marudesk && node -e "const p=require('./package.json'); if(p.version!=='0.0.2') process.exit(1)"
    Expected: exits 0.
    Evidence: command summary

  Scenario: Docs mention core feature
    Tool: bash
    Steps: rg "multi-root|Workspace Deck|workspace split" README.md marudesk/README.md CHANGELOG.md
    Expected: relevant entries found.
    Evidence: command summary
  ```

  **Commit**: YES | Message: `docs(release): document workspace deck release` | Files: `README.md`, `marudesk/README.md`, `marudesk/package.json`, `marudesk/package-lock.json`, `CHANGELOG.md`, `marudesk/docs/*`

- [ ] 13. Run Full Verification And Visual QA

  **What to do**: Run typecheck, build, MCP harness, targeted e2e, full e2e, screenshot harness, inspect actual screenshots, and perform a screenshot-based visual review for hierarchy, overlap, text fit, and token usage.
  **Must NOT do**: Mark visual QA passed based only on Playwright exit code.

  **Parallelization**: Can Parallel: NO | Wave 5 | Blocks: commit/PR | Blocked By: T1-T12

  **References**:
  - Commands: `marudesk/package.json` scripts.
  - Screenshots: `marudesk/e2e/screens.spec.ts:21`.
  - Design: `marudesk/DESIGN.md`.

  **Acceptance Criteria**:
  - [ ] `rtk npm run typecheck` exits 0 from `marudesk`.
  - [ ] `rtk npm run build` exits 0 from `marudesk`.
  - [ ] `rtk npm run harness:mcp` exits 0 from `marudesk`.
  - [ ] `rtk npx playwright test e2e/multi-workspace.spec.ts e2e/screens.spec.ts` exits 0.
  - [ ] `rtk npm run e2e` exits 0.
  - [ ] Screenshots are inspected via `view_image` and show no incoherent overlap.

  **QA Scenarios**:
  ```
  Scenario: Full automated QA
    Tool: bash
    Steps: run all commands listed in Acceptance Criteria.
    Expected: all exit 0.
    Evidence: command summaries

  Scenario: Screenshot inspection
    Tool: view_image
    Steps: inspect workspace single, workspace split, nested split, Peek Explorer screenshots.
    Expected: workspace hierarchy is visually clear; no text overlap; no double top tab bar.
    Evidence: visual notes in final QA report
  ```

  **Commit**: NO | Message: n/a | Files: n/a

- [ ] 14. Commit, Review Commit, Fix, And Recommit

  **What to do**: Stage only aligned files, excluding existing unrelated `mobile/` changes. Commit with OMC trailers. Run code-review agent on the diff. If review finds actionable issues, fix them, rerun impacted checks, and create a follow-up commit.
  **Must NOT do**: Commit unrelated `mobile/` worktree changes.

  **Parallelization**: Can Parallel: NO | Wave 5 | Blocks: PR | Blocked By: T13

  **References**:
  - OMC commit protocol in `omc-reference` skill.
  - Dirty worktree evidence: existing `mobile/` modifications before implementation.

  **Acceptance Criteria**:
  - [ ] `git diff --cached --name-only` before commit contains no `mobile/` files unless implementation explicitly touched them.
  - [ ] Commit exists on feature branch.
  - [ ] Commit review is run by a separate reviewer.
  - [ ] Any review fixes are committed separately or clearly included before PR.

  **QA Scenarios**:
  ```
  Scenario: Commit scope check
    Tool: bash
    Steps: git show --name-only --stat HEAD
    Expected: MaruDesk/docs/release files only; no unrelated mobile files.
    Evidence: command summary

  Scenario: Review remediation
    Tool: codex reviewer
    Steps: reviewer inspects HEAD diff and QA evidence.
    Expected: no unresolved severity findings before PR.
    Evidence: reviewer summary
  ```

  **Commit**: YES | Message: `feat(workspaces): add multi-root workspace deck` plus trailers | Files: all implementation files

- [ ] 15. Open, Review, Merge PR

  **What to do**: Create a feature branch, push to `origin`, open a GitHub PR against `master`, include QA evidence and screenshot artifacts/paths in the PR body, run PR review, address review comments, and merge once checks/reviews are acceptable.
  **Must NOT do**: Merge without confirming PR state and CI/check status where available.

  **Parallelization**: Can Parallel: NO | Wave 5 | Blocks: release | Blocked By: T14

  **References**:
  - Git remote: `origin https://github.com/Liruns/marudesk.git`.
  - GitHub skill/connector or `gh` CLI for PR/release operations.

  **Acceptance Criteria**:
  - [ ] `gh auth status` or GitHub connector confirms authentication.
  - [ ] PR URL exists.
  - [ ] PR body lists commands run and screenshot evidence.
  - [ ] PR is reviewed; actionable findings are resolved.
  - [ ] PR is merged into `master`.

  **QA Scenarios**:
  ```
  Scenario: PR state
    Tool: bash / GitHub connector
    Steps: query PR after merge.
    Expected: merged=true and base branch is master.
    Evidence: PR URL and status summary

  Scenario: Checks reviewed
    Tool: bash / GitHub connector
    Steps: inspect PR checks.
    Expected: no failing required checks, or no checks configured and local QA evidence attached.
    Evidence: checks summary
  ```

  **Commit**: NO | Message: n/a | Files: n/a

- [ ] 16. Build And Publish `0.0.2` Release With Attached Files

  **What to do**: From merged `master`, build package artifacts with `npm run package:win` on this Windows environment. Attach generated files from `marudesk/release/` matching `*.exe`, `*.blockmap`, and `latest.yml` to GitHub release `v0.0.2`; explicitly exclude `builder-debug.yml` and logs. Include release notes from `CHANGELOG.md` and QA evidence. If macOS artifacts are required but cannot be built on Windows, explicitly mark them unavailable and attach Windows artifacts only.
  **Must NOT do**: Create release before version/changelog are merged.

  **Parallelization**: Can Parallel: NO | Wave 5 | Blocks: final completion | Blocked By: T15

  **References**:
  - Build scripts: `marudesk/package.json:10` through `marudesk/package.json:12`.
  - Release output dir: `marudesk/package.json` `build.directories.output = release`.
  - Changelog: `CHANGELOG.md`.

  **Acceptance Criteria**:
  - [ ] `git checkout master && git pull --ff-only` succeeds after PR merge.
  - [ ] `cd marudesk && npm run package:win` exits 0.
  - [ ] Release `v0.0.2` exists on GitHub.
  - [ ] Release has attached package artifact(s).
  - [ ] Release notes include multi-workspace deck summary and verification commands.

  **QA Scenarios**:
  ```
  Scenario: Package artifacts
    Tool: bash
    Steps: cd marudesk && npm run package:win; list release directory.
    Expected: installer/blockmap/latest files exist as produced by electron-builder.
    Evidence: command summary

  Scenario: Release attachment
    Tool: GitHub connector / gh
    Steps: inspect GitHub release v0.0.2 assets.
    Expected: at least one desktop package artifact attached.
    Evidence: release URL and asset list
  ```

  **Commit**: NO | Message: n/a | Files: n/a

## Final Verification Wave (MANDATORY - after ALL implementation tasks)
> ALL must APPROVE before declaring completion.
- [ ] F1. Plan Compliance Audit: verify every TODO acceptance criterion and QA scenario has evidence.
- [ ] F2. Code Quality Review: separate reviewer inspects architecture, types, root containment, and UI complexity.
- [ ] F3. Real Manual QA: launch built Electron app, exercise workspace split, nested tab split, focus-follow Explorer, Peek Explorer, MCP context, and inspect screenshots.
- [ ] F4. Scope Fidelity Check: confirm mobile/relay unrelated changes were not committed, no fixed double top tab bar was introduced, and release/PR/merge requirements are complete.

## Commit Strategy
- Work on branch `feat/multi-workspace-deck`.
- Keep unrelated `mobile/` changes unstaged.
- Prefer coherent commits by wave when possible; if implementation spans too broadly, use one feature commit plus one review-fix commit.
- Required trailer template:
  ```text
  Constraint: Preserve existing tab split UX while adding workspace-level split
  Rejected: Permanent two-line top tab bar | too visually heavy
  Confidence: medium
  Scope-risk: broad
  Not-tested: <only if a requested gate truly could not run>
  ```

## Success Criteria
- Multi-root workspace deck is implemented and visually matches the approved concept: compact single-row normal mode, workspace pane split mode, local tabs, nested tab splits, focus-follow Explorer, and Peek Explorer.
- All verification commands pass or any pre-existing/environmental failures are proven and isolated.
- Separate plan review and commit/PR review are complete.
- PR is merged.
- Release `v0.0.2` exists with attached desktop package artifacts.
