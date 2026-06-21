# Mission Control — fundamental redesign

> Status: **converted & verified** on branch `feat/mission-control` (owner: full
> conversion, bold). The app now boots straight into Mission Control. Theme =
> Graphite & Minium theme + crisp/dense (same branch). Verified: typecheck · lint · unit
> 427/427 · build · harness 51/51 · a real GUI screenshot of the booted app
> (graph home, no rails, Evidence strip). Remaining = optional housekeeping +
> live-graph QA (see "Done / remaining" at the bottom).

## The one-line

Maru is a **runtime-aware mission control**: the **Task graph is the only home**
(nodes are *intents*, not tool windows). Browser, editor, and terminal are
**transient instruments** a selected Task summons into a right-hand **Instrument
Dock**, then dismisses. A Task is not "done" because the agent says so — it is
done when the **live app proves its acceptance criteria via CDP** (`0/2 → 2/2`).
This collapses the three layered paradigms (classic IDE / infinite canvas /
work-graph) into one spine: **meaning lives in nodes, tools live in the dock,
evidence lives on the timeline.**

## What it cuts / merges (end state)

- **CUT** the 3-mode `useSurfaceStore` switcher; **CUT** `CanvasStage`/`CanvasCard`
  + the canvas placement stores ("무한 쓰레기장"); **CUT** the classic `WorkspaceStage`
  tab-grid + split panes; **CUT** the left `ActivityBar` rail + persistent
  Explorer/Search/SourceControl panels; **CUT** Chrome-style tabs.
- **MERGE** the agent `ContextDrawer` chat into the per-Task **inspector** (you talk
  to the task, not a global bot); **MERGE** the `StatusBar` + `TitleBar` into one
  slim **Flight bar**.
- **DEMOTE** Explorer/Search/SourceControl to ⌘K-summoned instruments/commands; a
  **scratch task** + ⌘K ephemeral node is the chat-first escape hatch so trivial
  requests never feel like ceremony.

## Reused (already shipped — feasibility is high because of this)

WorkGraph store + scheduler (`features/work-graph/store.ts`), the worktree
apply → verify loop, the `WebContentsView` bounds pipeline
(`browser:set-pane-bounds`), the tab registry (`features/tabs/registry.tsx`),
runtime evidence (`shared/runtime-evidence.ts`, network-evidence).

## Phased build (each phase keeps typecheck green; replace-then-delete order)

- **Phase 1 — Home & chrome (THIS STEP).** Mission Control is the default & only
  home: `useSurfaceStore` defaults to `workgraph`; Shell renders the Task graph
  full-bleed with **no VSCode rails** (ActivityBar + Explorer/Search/SourceControl
  hidden). Chat stays reachable as a summonable drawer during the transition.
  Old `canvas`/`classic` stages still exist underneath (not yet deleted) so
  nothing breaks. ✅ when launching drops you straight into the graph home.
- **Phase 2 — Instrument Dock.** A right dock hosts the selected Task's instrument
  (browser / Monaco / terminal) via the existing `WebContentsView` bounds
  pipeline + tab registry — re-hosted into the dock instead of a grid/card. Move
  the agent chat into the Task **inspector** (per-node conversation). Selecting a
  node swaps the instrument; deselecting collapses the dock.
  - **Phase 2a — DONE (verified: typecheck/lint/unit/build).** `InstrumentDock.tsx`
    (right panel, opens when a task is selected) hosts the extracted
    `WorkGraphInspectorContent` on top + the agent chat below. `WorkGraphStage`
    gained a `docked` prop that suppresses the floating inspector; the Shell's
    Mission Control branch renders `<WorkGraphStage docked /> + <InstrumentDock/>`
    and no longer mounts the legacy `ContextDrawer`.
  - **Phase 2b — chat is still workspace-scoped** (one conversation, not per-task).
    Next: key agent sessions by `Task.id` so each node owns its conversation; add
    a flight-level transcript view so cross-node context isn't lost.
  - **Phase 2c — LIVE INSTRUMENTS (the deep slice; needs manual `npm run dev` QA).**
    Discovered wiring: the renderer→native bounds pipeline is
    `setBrowserPaneBoundsSource(sourceId, [{ tabId, rect }])` in
    `features/tabs/browserPaneBounds.ts` (batches → `browser:set-pane-bounds`); a
    DOM container's `getBoundingClientRect()` is reported via a `ResizeObserver`,
    and `<BrowserCanvas tabId=… />` already does exactly this. So the dock's
    instrument region renders the selected task's tool surface via the tab
    registry (`features/tabs/registry.tsx`) — `<BrowserCanvas tabId>` for web,
    the Monaco/terminal renderers otherwise — and the native `WebContentsView`
    paints over the dock rect automatically. **Risks to verify live:** native-view
    z-order vs the dock/graph, tab create/activate lifecycle when a task summons
    an instrument, and hiding the view when the task is deselected. Typecheck/tests
    will NOT catch a broken native overlay — must run the app.
- **Phase 3 — Evidence Timeline.** A bottom strip = the runtime "black box" scoped
  to the selected Task (navigations, console errors, network failures, agent
  page-actions, reload-verify), fed by the existing runtime/network evidence.
  Acceptance verdicts flip to real pass/fail from this, not the agent's word.
- **Phase 4 — Flight bar + ⌘K.** Replace `TitleBar` + `StatusBar` with one slim
  flight bar (goal title · running/passed/failed · model/approval · window
  controls). ⌘K goal/command entry; a trivial ask spawns an ephemeral scratch
  node (chat-first feel). Zoom-into-node → instrument fills the frame (from the
  "Atelier" runner-up) so the dock is never cramped.
- **Phase 5 — Delete the old surfaces.** Remove `CanvasStage`/`CanvasCard` + canvas
  stores, `WorkspaceStage` (classic) + `TabStrip`/split-grid, `ActivityBar` +
  the three rail panels (now ⌘K instruments/commands), collapse `useSurfaceStore`
  to a single surface, rewire the tab/pane keyboard shortcuts in `Shell`.
- **Phase 6 — Verify.** typecheck · lint · unit · build · harness · e2e · manual.

## Open risks (carried from the vision review)

Bets on users *wanting* to supervise a task graph (mitigated by the ⌘K ephemeral
node). One-instrument dock fights side-by-side work (mitigated by zoom-to-node +
a possible 2-up dock). Per-task chat fragments history (needs a flight-level
transcript view). Deleting two stages is irreversible-feeling — done only after
the new spine is fully load-bearing (Phases 2–4).

## Done / remaining (2026-06-21)

**Done & verified (green + GUI screenshot):**
- Phase 1 — Mission Control is the default & only home; graph full-bleed; no rails.
- Phase 2a — Instrument Dock (inspector + per-task agent chat), floating inspector
  retired in MC.
- Phase 2c — live instruments: a Task Resource opens a browser/editor/terminal as a
  full-area instrument via the tab registry + `WebContentsView` bounds pipeline
  (`InstrumentStage` + `instrument.ts`); "← Graph" returns home.
- Phase 3 — Evidence strip (bottom) summarising the selected task's acceptance
  verdicts + run note (replaces the StatusBar on this surface).
- Phase 4 — Flight status in the title bar (goal + done/total + failures).
- Phase 5 — `useSurfaceStore` pinned to `workgraph`; canvas/classic are unreachable.
- Phase 5 (cleanup) — the dead legacy Shell branch is removed and **37 now-orphaned
  files physically deleted**: `ActivityBar`, `StatusBar`, `CanvasStage` + the canvas
  UI (`CanvasCard`/`Minimap`/`Edges`/`Notes`/`PlanFlow`/`Sections`/`Shortcuts`),
  `WorkspaceStage` (classic) + the tab grid (`TabStrip`/`GridStage`/`Stage`/
  `PaneHeader`/`SplitGroup` + `TabChip`/`TabIndicator`/`TabGroup*`/`TabStripMenu`/
  `SeedDropOverlay`), the three rail panels + their `.parts`, `ContextDrawer` +
  `CaptureCard`/`SupervisorRail`/`SpecsPanel`, `FileTree`(+Pierre)/`Worktree*`.
  Kept (still shared/live): `canvas/store.ts`, `canvas/surface.ts`, `camera-math`,
  `edgeGeometry`, `tabs/grid.ts`, `tabs/registry.tsx`, and the instrument surfaces
  (`BrowserCanvas`/`EditorView`/`TerminalSurface`/`AgentTab`). Re-verified green
  after deletion: typecheck · lint · unit 427/427 · build · harness 51/51 · a boot
  screenshot (identical clean Mission Control home).

**Remaining (low-priority, gated on external state):**
- Live-graph QA: generating a real graph + opening an instrument needs a connected
  AI provider — exercise inspect→ask→patch→verify against a running page, and
  confirm the native instrument view's z-order in the main area.
- Phase 2b — per-Task agent sessions (chat is workspace-scoped today) + a
  flight-level transcript.
- A few canvas/classic **e2e specs** still assume the old surfaces (they seed
  `maru.surface`, now ignored) — update or remove them on the next e2e pass.
