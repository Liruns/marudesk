# Changelog

## 0.1.0 - 2026-06-07

First feature release. Aligns all three packages (`marudesk`, `mobile`,
`relay`) on a single `0.1.0` repository version. Full notes:
[`docs/releases/0.1.0.md`](docs/releases/0.1.0.md).

### Language intelligence & diagnostics
- Checker-driven diagnostics backend with a `read_diagnostics` source and a
  gated `run_diagnostics` agent tool.
- Tier 2 Language Server engine: live diagnostics, truncation-safe document
  sync, server init options, and a status surface.
- Problems indicator with Monaco squiggles, a Problems list popover with
  jump-to-line, externalized checker recipes (`languages.json`), an ESLint
  recipe, and more robust command resolution.

### Agent capabilities
- Gated `run_command` tool for running workspace commands.
- Tab-control MCP tools (open / activate / navigate / close).
- Detached background agents (spawn / collect / cancel).
- Drive the embedded Chromium via the `chrome-devtools` MCP preset.
- `spawn_subagent` is now usable for autonomous research; turn-completion
  receipts are scoped to the last turn.

### Profiles & workspaces
- Full app profiles with isolated data sets and a title-bar profile switcher.
- Refined pane header with an identity avatar and folder / SSH badges.
- "Add SSH folder" folded into the New Workspace flow.
- Persist and restore the deck split layout; persist the workspace registry
  across restarts.

### App & UX
- Splash window while the app loads.
- Interactive step-through product tour.
- Dedicated empty-stage screen for panes with no tabs.
- First-run guide and no-workspace guidance.
- Persist and restore window size, position, and maximized state.
- UX polish from screenshot review, a larger app-icon mark, and assorted
  fixes (workspace switch, editor focus, Ctrl+W, last-tab close, IPC return
  hardening).

## 0.0.1 - 2026-06-04

- Mark the first MaruDesk release baseline across the desktop app, mobile thin client, and relay service.
- Document the initial repository-level release entry.
