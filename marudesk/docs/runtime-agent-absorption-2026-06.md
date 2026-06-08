# MaruDesk — Runtime-Agent Absorption Plan (2026-06)

> Status: **proposal (2026-06-08)** · Scope: convert a fresh reference set —
> browser-agent and agent-ops products (Vessel, stagewise, Onlook, Stagehand,
> BrowserOS, webmux/cmux, OpenHands, Kiro, Cline/Roo/Kilo) — into concrete
> MaruDesk product decisions, biased toward the **browser stage + runtime
> evidence** differentiator.
> Companion docs (read first, this plan dedupes against them):
> [roadmap](./roadmap.md) · [design-benchmark-2026-06](./design-benchmark-2026-06.md) ·
> [agentic-chat-v5](./agentic-chat-v5-design.md) · [agentic-chat-v6](./agentic-chat-v6-design.md) ·
> [subagent](./subagent-design.md) · [background-agent](./background-agent-design.md) ·
> [context-mcp](./context-mcp-design.md) · [custom-devtools](./custom-devtools-design.md).
>
> This document is in English to match `DESIGN.md` and
> `architecture-review-2026-06.md`. File:line references are accurate at time of
> writing; re-confirm at implementation.

---

## 0. Executive summary

MaruDesk already ships the thesis: an in-process Chromium stage + CDP, a closed
**console-error → source-fix → reload-and-verify** loop, a multi-provider agent
loop with approvals/plan mode, in-process + external MCP, an isolated plugin
runtime, subagents, detached background agents, a multi-workspace deck, and a
mobile thin client. The design system (`DESIGN.md`, `tokens.css`) is mature.

The team has also *already planned* most chat-side competitor parity — unified
multi-file diff review, transcript verbosity dial, three-scope permissions, plan
cards/Taskboard, session receipts, checkpoints, worktree threads, automations,
in-chat artifacts, element comments (see
[design-benchmark-2026-06](./design-benchmark-2026-06.md) Top 10 and
[agentic-chat-v6](./agentic-chat-v6-design.md) W/G/U). **This plan does not
re-spec those.** It cross-references them and concentrates on the layer the new
reference set actually pushes hardest and that no chat-centric doc fully owns:
**making the running app a first-class agent surface.**

The wedge to widen, in one line:

> *The agent acts on your running app, every action is drawn on the page and
> recorded on a runtime timeline, and every action is reversible and tied back to
> a source edit.*

Three things are net-new, cheap relative to their impact, and impossible for a
source-only competitor to copy because they require owning the browser:

1. **Page highlights** — the agent visibly annotates the live stage as it reads,
   clicks, or is about to edit a node (Vessel, stagewise). Reuses the existing
   inspect overlay.
2. **Runtime evidence timeline** — a chronological strip of navigations, console
   errors, network failures, agent page-actions, and reload-verify results, with
   checkpoints (Vessel workflow tracking). The data already exists in the
   per-tab error ring buffer and `NetworkEntry`; this is mostly a projection.
3. **Element → agent** — select any element on the stage and hand it to the agent
   as context with a best-effort source jump (stagewise, Onlook), generalizing
   the shipped console-error "Fix this" to *any* DOM node.

Everything else in the new set is either already planned (worktree lanes, diff
review, spec/plan surfaces, MCP install UX) — where this plan adds a
runtime-aware twist and points at the owning doc — or a deliberate **non-goal**
(generic app builder, visual CSS editor; see §9).

---

## 1. Current state — what exists vs. what is missing

Grounded in the shell (`src/views/Shell.tsx`), the feature slices
(`src/features/*`), the main process (`electron/*`), and shared contracts
(`shared/*`).

**Shell IA today** (`Shell.tsx:99-341`): `TitleBar` (Chrome-style tabs) → work
row [`ActivityBar` left-rail icons + one of `ExplorerPanel`/`SearchPanel`/
`SourceControlPanel` + `WorkspaceStage` (tabs-as-features on a split-pane grid) +
`ContextDrawer` (right, collapsible, the agent)] → `StatusBar`. Overlays:
`QuickOpen` (Ctrl/Cmd+P), `TabPalette` (Ctrl/Cmd+Shift+A), `ToastHost`, `Tour`.
**The browser is a tab kind (`web`), not a permanent center** — a deliberate,
shipped choice. This is the single most important constraint for the IA proposal
in §3.

| Capability | State | Where |
|---|---|---|
| In-process Chromium stage + tabs + split grid | ✅ | `features/tabs/*`, `features/workspaces/WorkspaceStage.tsx`, `electron/browser/*` |
| CDP runtime capture, always-on console ring buffer + error badge | ✅ | `electron/browser/{cdp,state,tabs}.ts`, `devtools:pull-errors` |
| Custom DevTools dock (Console/Network/Elements/Application/Rendering/REPL) | ✅ | `features/devtools/*`, `panels/*` |
| Console-error → source "Fix this" → reload-and-verify (closed loop) | ✅ | `panels/ConsolePanel.tsx`, `shared/runtime-evidence.ts`, `electron/llm.ts` |
| Element capture (Elements pick → capture cart → composer) | ✅ | `devtools/store.ts` `captureSelected`, `electron/inspect-overlay.ts`, `features/context/CaptureCard.tsx` |
| Network body read + secret scrub | ✅ | `read_network*` tools, `shared/scrub.ts` |
| Agent loop: streaming, reasoning dial, approvals (once/skip), plan mode | ✅ / 🟡 | `electron/agent/loop.ts`, `features/agent/AgentChat.tsx` |
| Per-edit accept/revert diff history | ✅ | patch flow, `shared/patch.ts` |
| In-process + external MCP, isolated plugin runtime | ✅ | `electron/agent/mcp/*`, `electron/plugins/*` |
| Subagents (in-turn) + detached background agents | ✅ (Phase 1) | `electron/agent/{subagent-runtime,background}.ts`, `BackgroundTray.tsx` |
| Multi-workspace deck, SSH roots | ✅ | `electron/workspace*`, `features/workspaces/*`, `electron/ssh/*` |
| Mobile thin client + relay bridge | ✅ | `mobile/*`, `relay/*`, `shared/remote.ts` |
| **Agent page-action highlights on the live stage** | ⬜ | inspect-overlay exists but is user-pick only |
| **Runtime evidence timeline (cross-source, chronological)** | ⬜ | data exists in error buffer + `NetworkEntry`; no projection |
| **Element → agent for *any* node (not just console errors)** | 🟡 | capture exists; no floating stage affordance, no first-class "ask/fix this element" |
| **Network/DOM → source "triage/fix" (beyond console)** | 🟡 | console only is closed-loop |
| **Supervisor view (agent goal + page-action log + checkpoints)** | 🟡 | `ContextDrawer` is transcript projection only |
| **Checkpoints tied to runtime (source snapshot + page state)** | ⬜ / planned | message checkpoints planned in v6; no runtime marker |
| **Unified multi-file diff + hunk accept/reject** | 🟡 / planned | `DiffBlock` + per-edit revert; unified review planned (benchmark Top1, v6 U1/U2) |
| **Worktree / agent-lane dashboard (per-lane dev server / PR / CI)** | 🟡 / planned | deck + subagent + background; worktree threads planned in v6 §C |
| **Spec lifecycle surface (requirements→design→tasks) + steering files** | ⬜ / partial | plan mode + Taskboard planned (v5 G2); Kiro-style spec lifecycle absent |
| **MCP/plugin one-click install + manage UX** | 🟡 / planned | Settings panels exist; install UX thin (v6 W2) |
| **Browser action preview before run + cached repeatable actions** | ⬜ | gated `eval_js`/click exist; no preview/highlight, no saved action cache |

Read: the *chat* is competitive and well-planned; the *running-app-as-agent-
surface* is where the cheap, defensible wins remain.

---

## 2. Proposed information architecture

The requested IA — fixed center browser, right agent/supervisor rail, bottom
DevTools/evidence drawer, left workspace/worktree/session rail, overlay
palette/transcript/inspector — describes Vessel/stagewise, **not** MaruDesk's
shipped tabs-as-features grid. Forcing a fixed 4-zone frame would regress the
split-pane stage that already lets a user tile browser + editor + terminal +
agent. The right move is a **layout preset**, not a rewrite.

**Decision: add a "Runtime / Debug" workspace layout preset** that arranges the
existing surfaces into the requested IA, while the flexible grid remains the
default. The preset is just a saved arrangement of existing primitives plus two
new docks; no new windowing system.

```
┌───────────────────────────── TitleBar (tabs) ─────────────────────────────┐
│ Act │ Left rail            │            STAGE (web tab, dominant)        │ R │
│ ivi │ Explorer / Search /  │   ┌─────────────────────────────────────┐   │ a │
│ ty  │ SourceControl /      │   │  live page + agent page-highlights  │   │ i │
│ Bar │ ✦ Lanes (new)        │   │            (overlay)                │   │ l │
│     │                      │   └─────────────────────────────────────┘   │ ✦ │
│     │                      │  ── Evidence dock (bottom, new) ─────────── │ S │
│     │                      │  timeline · console · network · elements    │ u │
└─────┴──────────────────────┴──────────────────────────────────────────┴───┘
                              StatusBar (workspace · inspect · model · usage)
```

- **Center = Stage.** The active `web` tab, with the agent's page-highlight
  overlay on top. In the preset, a web tab is pinned to the largest pane.
- **Right = Supervisor rail.** A *mode* of the existing `ContextDrawer`
  (380px, `DESIGN.md` Drawer spec). Two segmented modes: **Transcript** (today's
  chat projection) and **Supervisor** (agent goal, active tool, page-action log,
  pending approvals as persistent badges, checkpoints). One rail, two lenses —
  not a second drawer.
- **Bottom = Evidence dock.** A bottom drawer (`DESIGN.md`: 60vh max) that hosts
  the **runtime evidence timeline** plus the existing DevTools panels. This is
  the existing DevTools dock, promoted from "F12 toggle for the active web tab"
  to a first-class evidence surface with the timeline as its spine.
- **Left = Workspace + Lanes rail.** The existing `ActivityBar` gains a **Lanes**
  view (`features/lanes/*`, new) alongside Explorer/Search/SourceControl: the
  agent-lane / worktree dashboard (§4.8). Sessions/history stay where they are
  (agent rail), surfaced per-lane.
- **Overlays.** Extend the shipped overlay set: `QuickOpen`/`TabPalette` →
  a unified **command palette** (benchmark Top5, already planned); add an
  **element inspector** floating panel on element pick (§4.7) and a compact
  **transcript dock** option for watching chat while a web tab is maximized.

Everything above maps to an existing primitive (drawer, dock, activity-bar view,
overlay). The preset is selectable from a layout menu (benchmark §E "layout
presets"); the default grid is unchanged.

---

## 3. Feature packages

Each package: user story · UI placement · state model · main-process support ·
renderer components · IPC/contracts · tests · risks · MVP · later. Packages
already owned by another doc are kept tight with a cross-reference; the
browser-differentiated, net-new ones are fuller. Priority tags: **P0** (Now),
**P1** (Next), **P2** (Later).

### 3.1 Page highlights — **P0 · SHIPPED (2026-06-08)** · refs: Vessel, stagewise, BrowserOS

- **User story.** "When the agent reads, clicks, or fills a node, I see it light
  up on the live page, so I can follow and trust what it's doing."
- **UI placement.** Drawn *inside* the page over the resolved element (a labeled
  accent box). **Review correction:** the web view is a native `WebContentsView`
  composited above the renderer, so a renderer overlay (`BrowserStageOverlays.tsx`)
  would render *under* the page — highlights must be injected, the same technique
  as the inspect picker.
- **State model.** None persisted — each highlight is a transient in-page node that
  self-removes after a 2s TTL; a navigation drops it with the old document.
- **Main-process support.** `electron/agent/tools/highlight.ts` — a self-contained,
  injection-safe page function run fire-and-forget through the existing allowlisted
  `Runtime.evaluate` (`shared-helpers.ts` `evaluate` path). The five page-acting
  tools (`query_dom`, `click`, `fill`, `press_key`, `scroll`) call
  `highlightInPage(rec, selector, label)`.
- **Renderer components.** None — the box is page DOM, not React.
- **IPC/contracts.** None new — reuses the allowlisted `Runtime.evaluate`.
- **Tests.** typecheck + build + lint + `harness:mcp` (149/149) green; real-UI
  smoke pending a display (run `npm run dev`, drive a `click`/`query_dom`).
- **Risks.** A subsequent `read_page`/`query_dom` within the TTL could include the
  `[data-marudesk-agent-highlight]` node (self-clears; low). Viewport coords don't
  track scroll (short TTL; acceptable). Chrome-DevTools CDP contention degrades
  silently.
- **Later.** Highlight gated browser actions *before* execution (§3.12 preview);
  error→node pin; multi-node query-result highlight; replay along the timeline.

### 3.2 Element → agent (stage capture) — **P0 · SHIPPED (2026-06-08)** · refs: stagewise, Onlook

> Shipped as reveal-on-pick: a stage pick switches to the Captures tab and opens
> the drawer (`useComposerStore.revealCaptures` → `Shell`), so the existing
> capture card / focused "Send to agent" / source ranking are immediately
> actionable. The floating in-page toolbar below remains *later*.

- **User story.** "I click an element on the running page and say *fix this* or
  *explain this* — the agent gets the element, its surroundings, and a best-effort
  source location."
- **UI placement.** A floating, draggable mini-toolbar on the Stage when inspect
  mode is armed (StatusBar already exposes inspect mode); on pick, an action
  popover: *Ask about this · Fix this · Add to context*.
- **State model.** Reuse the `Capture` discriminated union
  (`shared/capture.ts`, `kind: 'element' | 'console-error'`) — already built for
  exactly this. Add no new kind; route element picks through the existing
  `addCapture` → capture cart → composer path.
- **Main-process support.** Reuse `electron/inspect-overlay.ts` /
  `electron/browser/inspect.ts` pick + `browser:capture` (`kind:'element'`) and the
  existing element ranking (`workspace/store.ts` `rankCapture`). Best-effort
  source jump reuses `css-source.ts` same-origin
  mapping for styles; for DOM, surface candidates with confidence (honest, per
  roadmap §7 — never claim exact line).
- **Renderer components.** `StageInspectToolbar.tsx` (floating), reuse
  `CaptureCard.tsx`; composer quick-action buttons.
- **IPC/contracts.** None new — `browser:capture` carries `kind:'element'` today.
- **Tests.** e2e: arm inspect → pick → assert capture lands in cart with element
  payload + at least a file candidate; verify "Fix this element" seeds composer.
- **Risks.** Cross-origin / Vite JS-injected styles are live-only (documented in
  roadmap §2) — frame source jump as a *candidate*, not a guarantee. Avoid drift
  into a visual CSS editor (non-goal, §9).
- **MVP.** Pick → "Add to context" + "Ask about this" (no auto-edit).
- **Later.** "Fix this element" closed loop (edit → reload → re-pick → verify the
  visual/behavioral change), mirroring the console loop.

### 3.3 Runtime evidence timeline — **P0 · MVP SHIPPED (2026-06-08)** · refs: Vessel (workflow tracking), Stagehand

> Shipped MVP: a read-only DevTools **Timeline** panel
> (`src/features/devtools/panels/EvidenceTimeline.tsx`) merging console
> errors/exceptions/warnings + failed/4xx/5xx network requests on one wall-clock
> axis (network `wallTime` now captured at `requestWillBeSent`), each row jumping
> to its panel. Navigation / agent-action / reload-verify rows + the main-side
> merger remain *later* (below).

- **User story.** "I see a single chronological stream of what happened to the
  running app — navigations, console errors, failed requests, agent page-actions,
  reload-verify results — and can jump from any event to its evidence."
- **UI placement.** The spine of the Evidence dock (bottom). A condensed
  one-line strip can also ride the StatusBar / Supervisor rail.
- **State model.** `RuntimeEvent` discriminated union: `navigation | console-error
  | network-failure | agent-action | reload-verify | checkpoint`, each `{ id;
  tabId; ts; summary; ref }` where `ref` points back to the owning record
  (console buffer entry, `NetworkEntry`, tool call, checkpoint id). Kept per-tab,
  capped ring buffer (reuse the cap-50 pattern from the error buffer).
- **Main-process support.** Aggregate from existing sources rather than capture
  anew: per-tab error ring buffer (`electron/browser/state.ts`), `NetworkEntry`
  failures (`devtools/store.ts`), agent browser-tool calls (loop), and
  `reload_and_verify` outcomes. A small `electron/browser/timeline.ts` merger;
  emit coalesced (reuse the `agent:event` coalescing pattern).
- **Renderer components.** `EvidenceTimeline.tsx` (horizontal lanes by source,
  color via AI-timeline tokens only for agent-action rows; semantic `--error`
  for failures), row → jump handler that opens the owning panel/capture.
- **IPC/contracts.** Event `runtime:timeline` `{ tabId; events: RuntimeEvent[] }`;
  invoke `runtime:timeline-pull` `{ tabId } → RuntimeEvent[]` (mirror of
  `devtools:pull-errors`).
- **Tests.** Unit: merger ordering/dedup; e2e: drive console error + nav + a
  fake agent click, assert ordered timeline + jump targets resolve.
- **Risks.** Noise (cap, and default-filter to errors + agent actions + nav,
  network successes off by default — mirrors the passive-`Runtime`-only decision
  in roadmap §10). Keep it read-only first.
- **MVP.** Read-only vertical list in the Evidence dock sourcing console errors +
  navigations + network failures (all already captured), with jump.
- **Later.** Agent-action + reload-verify rows; checkpoints as timeline markers;
  export to the session receipt / `evidence-pack.ts`.

### 3.4 Console / network / DOM → source "Fix this" loop — **P1** · extends shipped

- **User story.** "Any runtime symptom — a console error (shipped), a failed
  request, or a misbehaving element — carries a one-click path to a source fix
  and a verify."
- **Cross-ref.** Console is shipped (roadmap §6/§10). This package *extends the
  same boundary* (`shared/runtime-evidence.ts`, `electron/llm.ts` /
  agent tools) to network (triage framing — backend failures are *classified*,
  not auto-fixed, per roadmap §5) and DOM elements (§3.2). No new architecture;
  new `kind` branches and prompt builders.
- **MVP.** Network "Triage this" (status/headers/initiator → context, scrubbed).
  **Later.** DOM-element closed loop; per-symptom-type accuracy measurement
  (roadmap P2 dogfood).

### 3.5 Supervisor rail — **P1** · partial · refs: Vessel, Codex task sidebar, Antigravity

- **User story.** "Beside the transcript I have a calm control surface: the
  agent's current goal, the tool it's running, what it's done to the page, what's
  blocked, and the checkpoints I can roll back to."
- **UI placement.** Second mode of `ContextDrawer` (segmented control:
  Transcript | Supervisor). Pending approvals render as persistent rail badges,
  not modals (benchmark Top4 "Blocked as sidebar badge").
- **State model.** Projected, read-mostly, from the single `AgentChatState`
  snapshot (no second snapshot — honor the projection invariant in
  subagent/background docs): current goal/plan step, active tool call,
  page-action log (from §3.3 agent rows), `pending` interactions, checkpoint list.
- **Main-process support.** None new beyond surfacing existing loop state; reuse
  `agent:event`.
- **Renderer components.** `SupervisorRail.tsx`, `ApprovalBadge.tsx`,
  `PageActionLog.tsx`; segmented control in `ContextDrawer`.
- **IPC/contracts.** None new (reads the existing snapshot).
- **Tests.** e2e: gated tool parks → assert persistent rail badge (not modal) →
  approve from rail.
- **Risks.** Overlap with planned Taskboard/Mission Control (v5 G2 / v6) — keep
  Supervisor as the *single-session, page-focused* lens; the multi-session board
  is §3.8. Don't fork the snapshot.
- **MVP.** Goal + active tool + pending-approval badges.
- **Later.** Page-action log + inline checkpoint restore.

### 3.6 Checkpoints & rollback (runtime-aware) — **P1** · partial · refs: Vessel (action undo), Zed/VS Code

- **User story.** "I can restore to a point before the agent's last few actions —
  and that restores *both* my source files and the page state I was looking at."
- **Cross-ref.** Message-level source checkpoints are planned in v6. **This
  package's contribution is the runtime half:** snapshot the source (git stash /
  worktree ref) *and* a runtime marker `{ url; scroll; formState? }` so a restore
  re-navigates the stage to match.
- **State model.** `Checkpoint { id; messageId; sourceRef; runtimeMarker; ts }`;
  list in Supervisor rail + timeline markers.
- **Main-process support.** Source snapshot via git (stash or worktree, shared
  with §3.8); runtime marker captured before each gated mutating browser action /
  before each edit-bearing turn.
- **Risks.** Page state restore is best-effort (SPA state isn't always URL-
  addressable) — restore navigation + scroll only in MVP, label it honestly.
- **MVP.** Source restore + re-navigate to checkpoint URL.
- **Later.** Form/scroll/storage restore where deterministic.

### 3.7 Visual element inspector / code jump — **P1** · partial · refs: Onlook, stagewise

- **User story.** "Picking an element shows me its box, attributes, computed
  styles, and a jump to the most likely source — as a debugging aid, then a
  hand-off to the agent."
- **Cross-ref / boundary.** Builds on the shipped Elements panel
  (`devtools/store.ts`) and §3.2. **Explicit non-goal:** live visual CSS editing
  (Cursor Visual Editor / Lovable / Onlook territory) — `css-source.ts` only maps
  same-origin static CSS; over-promising is rejected in roadmap §2.
- **UI placement.** Floating inspector panel on pick (overlay), or the Elements
  panel in the Evidence dock.
- **MVP.** Box + attributes + computed styles + "send to agent" (read-only).
- **Later.** Source-candidate ranking with confidence; "jump to file" when
  same-origin mapping is deterministic.

### 3.8 Worktree / agent-lane dashboard — **P2** · partial/planned · refs: webmux, cmux, OpenHands, Codex worktree threads

- **User story.** "I run several agent tasks in parallel, each isolated in its own
  git worktree with its own dev server and browser tab, and I watch branch / port
  / dev-server health / PR / CI in one board."
- **Cross-ref.** Parallel threads + worktree execution mode are decided in
  [agentic-chat-v6](./agentic-chat-v6-design.md) §C/§G2; subagents and background
  agents ship today. **This package is the runtime-aware dashboard on top:** each
  lane can own a `web` tab pointed at its own dev server, and the board shows the
  lane's runtime health (the differentiator webmux/cmux lack — they show terminals
  and CI, not a live in-app browser per lane).
- **UI placement.** New **Lanes** view in the `ActivityBar` (left rail) →
  `features/lanes/*`; a lane opens its own grid arrangement (stage + transcript).
- **State model.** `Lane { id; title; worktreeRef; branch; devServer?: {port;
  status}; sessionId; agentStatus; pr?; ci? }`. Honors single-snapshot projection
  per session; the board aggregates lane summaries.
- **Main-process support.** Worktree primitives already exist
  (`electron/git-worktree.ts` + `git-worktree.harness.ts`) — build lanes on them
  rather than from scratch; add dev-server port discovery (terminal scan); reuse
  subagent/background runtime per lane. Keep account-scoped/payload-agnostic on
  the relay.
- **Risks.** Tension with the "companion that patches your real folder" framing
  (roadmap §2) — worktrees isolate from the watched folder. Keep worktree mode
  *opt-in* per lane; default lane = the user's folder.
- **MVP.** Lane list + per-lane session + branch; manual worktree.
- **Later.** Per-lane dev server + browser tab + PR/CI status; promote
  background-agent tray into the board.

### 3.9 Git diff / hunk review — **P1** · partially shipped · refs: Terax, Zed, Codex

- **Cross-ref.** Further along than the benchmark implied: `DiffViewer.tsx`
  (split/unified via `@pierre/diffs`), `git-parse.ts`, and inline review comments
  (`features/agent/chat/diffComments.ts`, "Send N comments") already ship; unified
  *multi-file* review + Hashline edits remain owned by v5 G1 / v6 U1-U2.
  **This plan's only addition:** a diff hunk that originated from a runtime symptom
  should link back to the timeline event that triggered it (evidence → edit
  provenance). Add a `sourceEvidenceRef` on agent edits and a jump from the diff
  comment row to the timeline.

### 3.10 Spec / task / plan surface — **P2** · partial · refs: Kiro, Antigravity, Windsurf workflows

- **Cross-ref.** Plan mode ships; Taskboard is v5 G2; pre-flight Implementation
  Plan is benchmark Top6. **Kiro-specific net-new:** a versioned **spec
  lifecycle** (`requirements → design → tasks`) and **steering files** as
  workspace artifacts.
- **MVP.** `.marudesk/steering/*.md` (project-scoped, always-on agent guidance)
  **— SHIPPED (2026-06-08):** every `.md` under `<root>/.marudesk/steering/` is
  name-sorted, bounded (20 files / 16k chars), `@import`-expanded, and folded into
  the workspace instruction block (`electron/agent/instructions.ts`
  `loadSteeringFiles`). Still to do: `.marudesk/workflows/*.md` slash invocation
  (benchmark §E, Windsurf).
- **Later.** Full spec lifecycle objects (open/review/annotate/archive) reusing
  the Artifacts surface (v6 §D, plugin iframe runtime).

### 3.11 MCP / plugin / tool management UX — **P2** · planned elsewhere · refs: Claude .mcpb, Codex Skills

- **Cross-ref.** Owned by v6 W2 (Settings install/manage panel, one surface for
  MCP + plugins, version/compat display). No additional spec here; this plan only
  asks that **runtime/browser tools be a visible, toggleable group** in that panel
  so users can see (and gate) exactly the page-acting tools.

### 3.12 Browser action preview + cached actions — **P1/P2** · net-new · refs: Stagehand

- **User story.** "Before the agent clicks or evals against the page, I see *what*
  it will touch (highlighted) and approve it; repeatable actions can be saved and
  replayed."
- **UI placement.** Approval card (Supervisor rail) shows the target via §3.1
  highlight before executing a gated browser mutation.
- **MVP (P1).** Preview-via-highlight on gated browser actions (pairs with §3.1 +
  approvals).
- **Later (P2).** "Save this action" → a cached, parameterized browser workflow
  (stored under `.marudesk/workflows/`), replayable without the model.

---

## 4. Prioritized roadmap

Compass (roadmap §1): dogfood + portfolio, not moat. Sequence biases to the
browser differentiator and reuses shipped assets.

### Now — 1-2 weeks
- **N1. Page highlights MVP (§3.1). — SHIPPED (2026-06-08).** `query_dom`,
  `click`, `fill`, `press_key`, and `scroll` draw a transient labeled box over the
  resolved selector. *Review correction:* highlights are **injected into the page**
  (`electron/agent/tools/highlight.ts`, fire-and-forget via the existing
  `Runtime.evaluate` path), not rendered in `BrowserStageOverlays.tsx` — the web
  view is a native `WebContentsView` composited above the renderer, so a renderer
  overlay would sit *under* it (the same reason the inspect picker injects). No new
  IPC, no CDP allowlist change.
- **N2. Element → agent (§3.2). — SHIPPED (2026-06-08).** *Review finding:* the
  pipeline was ~90% built (`ElementCaptureCard` has comment + focused "Send to
  agent" + source ranking + evidence copy; captures surface in the composer). The
  real gap was a pick being **invisible behind a collapsed drawer** — closed by a
  reveal-on-pick nonce (`useComposerStore.revealCaptures` → Shell opens the drawer
  on the Captures tab). The floating in-page stage toolbar is now **SHIPPED
  (2026-06-08)** too — an injected pill (toggle from the browser menu) whose
  "Send element to agent" button starts the picker via the always-present inspect
  preload bridge (`startInspect` → `inspect:start`).
- **N3. Runtime evidence timeline, read-only (§3.3 MVP). — SHIPPED (2026-06-08).**
  A new DevTools **Timeline** panel merges console errors + network failures on a
  single wall-clock axis (newest first), each row jumping to its panel.
  *Review correction:* network needed a wall-clock field — `requestWillBeSent`'s
  `wallTime` is now captured (the monotonic `startTime` isn't comparable with the
  console's wall-clock `timestamp`). Renderer-only projection; navigation /
  agent-action / reload-verify rows remain the later main-side merger.
- **N4. Design-benchmark Sprint-1 polish — SHIPPED (2026-06-08).** Custom
  scrollbar, `--ring` focus-visible, and positive small-text tracking were already
  applied (`index.css` / `tokens.css` / tailwind `fontSize`); the remaining gap —
  global Lucide stroke 1.5 — is now set via `<LucideProvider strokeWidth={1.5}>`
  at the React root (verified on a real rendered icon).

### Next — 3-6 weeks
- **X1. Page-action log (§3.5) — SHIPPED (2026-06-08).** Rather than a separate
  Supervisor rail (redundant with `ThreadBar` + `AgentChat`), the agent's live-page
  actions now appear as a third source on the **Timeline** (N3): click/fill/scroll/
  eval/query_dom/reload_and_verify merged onto the same wall-clock axis as console
  + network, with an All/Problems/Actions filter. Done renderer-only — tool calls
  already carry name/input/state + `message.timestamp` in agent state.
- **X2. Network "Triage this" + element→agent fix-loop (§3.4). — SHIPPED
  (2026-06-08).** The Network detail / timeline already triaged failed requests;
  now the element capture card also has a **"Fix this"** action that sends the
  element to the agent with explicit fix instructions (root-cause → fix → reload
  + verify) — the element analog of the console/network fix loop.
- **X3. Runtime-aware checkpoints (§3.6)** layered on the v6 message-checkpoint
  work: source snapshot + re-navigate marker.
- **X4. Browser action preview-via-highlight on gated actions (§3.12 MVP).
  — SHIPPED (2026-06-08).** Gated click/fill/press_key/scroll highlight their
  target on the page while parked for approval (`previewGatedAction` /
  `clearActionPreview` in `highlight.ts`, wired at the loop's approval gate).
- **X4b. Evidence timeline actionability. — SHIPPED (2026-06-08).** Timeline rows
  run the existing fix (console) / triage (network) loops, not just navigation.
- **X5. Timeline ↔ edit provenance (§3.9) — SHIPPED (2026-06-08).** The agent's
  file edits now appear as rows on the Timeline, on the same wall-clock axis as
  the console/network/page-action evidence that prompted them; clicking an edit
  row opens the file. Renderer-only (edits already carry path + timestamp).

### Later — 2-3 months
- **L1. Agent-lane / worktree board (§3.8) — SHIPPED (2026-06-08):** the Source
  Control panel lists every worktree of the active repo + change counts
  (`git:worktree-list`, `WorktreeLanes.tsx`) and discards stale agent lanes inline
  (`git:worktree-remove`, refuses main / non-agent trees). Per-lane dev server /
  browser / PR / CI orchestration remains the larger follow-on.
- **L2. Session Receipt — running-app snapshot — SHIPPED (2026-06-08):** the
  ReceiptCard captures the live page on demand (`browser:capture-page-data`),
  kept out of the snapshot/persistence.
- **L3. Steering files + workflows, then spec lifecycle (§3.10).** Steering files
  **SHIPPED (2026-06-08)**; cached browser workflows **SHIPPED (2026-06-08)** —
  save the chat's page actions to `.marudesk/workflows/*.json` and replay them
  model-free via the existing executors (Timeline "Save as workflow" + a saved-
  workflows replay/delete list). Spec lifecycle **SHIPPED (2026-06-08)** — a Specs
  ContextDrawer tab backed by `.marudesk/specs/*.json` (title + markdown body +
  checkable task list), with "Send to agent" to hand a spec over as a turn.
- **L4. Cached browser workflows (§3.12 later); element inspector source-candidate
  jump (§3.7 later) — SHIPPED (2026-06-08):** ranked source rows on the element
  capture card open the file in the editor.
- **L5. Runtime/browser tools as a toggleable group (§3.11) — SHIPPED
  (2026-06-08):** Agent settings now lists the page/system-acting tool groups
  (browser/devtools/terminal/web) with their tool names + an on/off switch that
  gates the group via the existing `agent.denyTools` deny list (new
  `agent:list-tools` IPC). The broader MCP/plugin install/manage panel remains v6
  W2's surface.

- **L6. Turn checkpoints (§3.6) — SHIPPED (2026-06-08):** every turn snapshots the
  agent's working tree (`git stash create` — non-destructive) and the session
  receipt offers "Restore checkpoint" to roll the WHOLE tree back, capturing even
  terminal-driven changes the edits list misses. Safe by construction — current
  work is parked on the stash stack before the snapshot is re-applied, never
  `--force`/`reset --hard` — so nothing is destroyed. Verified on a real repo in
  the worktree harness.

> **Every roadmap item across §3.1–§3.12 is shipped, and the §3.8 Mission Control
> subsystem is now substantially built too:** the lanes board does per-lane
> **merge + discard** (`git:worktree-merge-lane` / `git:worktree-remove`) and runs
> a per-lane **dev server** — `settings.lanes.devCommand` spawned (node-pty) in the
> lane's directory, with live status, scraped localhost URL, stop, and open-in-tab
> (`lanes-dev:*`, pushed on `lanes:dev-state`) — and per-lane **Open PR**
> (`git:worktree-open-pr`: push the branch + open the GitHub compare/create-PR page,
> no in-app GitHub API). Specs gained a draft → active → review → done **status
> lifecycle**. The only piece left is live per-lane **CI status**, which needs
> GitHub API polling (out of the app's current scope — no `gh`).
>
> **Verified:** full Playwright e2e **125/125** (timeline + filter + edit
> provenance, receipt snapshot, worktree lanes + merge + discard, **per-lane dev
> server start/url/stop**, icon stroke, agent tool catalog, spec CRUD + status,
> Supervisor/Specs drawer tabs, stage-toolbar toggle, and the full workflow
> save→replay→DOM-effect loop), renderer + main unit tests **59**, and the
> git-worktree harness **41 assertions** (incl. the checkpoint "nothing is lost"
> guarantee).

---

## 5. Competitor / feature absorption matrix

Difficulty/priority are MaruDesk-relative. Licensing column flags only what to
**verify before reading source** — borrow interaction patterns, never vendor code
(per the task constraint). Where unsure, the entry says *verify*.

| Project | Category | Relevant features | UX pattern to copy | Difficulty in MaruDesk | Risk / licensing | MaruDesk adaptation | Priority |
|---|---|---|---|---|---|---|---|
| **Vessel Browser** | Browser-agent | supervisor sidebar, transcript dock, checkpoints, action undo, **page highlights**, DevTools+agent panel, workflow tracking | highlight the live page as the agent acts; timeline of runtime actions; rollback | Med (highlights low; timeline med) | Verify license; patterns only | §3.1 highlights, §3.3 timeline, §3.5 supervisor, §3.6 checkpoints | **P0/P1** |
| **stagewise** | Agentic IDE | select element → context → patch → diff | floating stage toolbar → element to agent | Low (capture union exists) | Verify license (reportedly copyleft) — patterns only | §3.2 element→agent | **P0** |
| **Onlook** | Visual builder | element outline, layer tree, **style inspector**, exact code jump | element inspector + source jump | Med | Apache-2.0 (verify); **reject visual CSS edit** | §3.7 inspector as debug aid only; non-goal: visual editing | **P1/non-goal** |
| **Stagehand** | Browser agent SDK | preview AI actions before run; cache repeatable actions | preview-via-highlight + saved actions | Med | MIT (verify) | §3.12 action preview + cached workflows | **P1/P2** |
| **BrowserOS / BrowserMCP / Playwright MCP** | Agentic browser / MCP | browser as MCP runtime, token-efficient a11y snapshots, existing-session control | accessibility-tree snapshots over raw DOM dumps | Low-Med | Apache/MIT (verify) | token-efficient `read_page` snapshots; runtime tools already MCP | P1 |
| **webmux** | Agent ops | parallel agents in worktrees; terminals, **PR/CI, dev-server health** in one board | lane board with branch/port/PR/CI | High | Product (no code copy) | §3.8 lanes — add per-lane *in-app browser* (our edge) | **P2** |
| **coder/cmux** | Agent ops | task lanes in isolated envs | isolated lane per task | High | AGPL (verify) — patterns only | §3.8 worktree lanes | **P2** |
| **OpenHands** | Agent platform | sandboxed exec, resumable sessions, web/CLI parity | resumable session + sandbox | High | MIT (verify) | resume ships; sandbox = worktree lane | P2 |
| **Kiro** | Spec-driven IDE | specs (req→design→tasks), hooks, steering files, MCP | spec lifecycle + steering files as artifacts | Med-High | Proprietary product — concept only | §3.10 steering files + spec lifecycle (reuse Artifacts) | **P2** |
| **Cline / Roo / Kilo** | VS Code agents | approval gates, tool-call cards, mode/role select, task history | per-tool approval + mode selector + history | Low (mostly shipped/planned) | Apache/MIT (verify) | reinforce approvals (benchmark Top3, v6) | P1 (planned) |
| **Terax** | Terminal-first IDE | split panes, **hunk-level AI diff**, source-control panel, git graph | keyboard split panes + hunk accept/reject | Med | Verify | §3.9 unified diff (planned); git graph optional | P1 (planned) |
| **Harnss** | Agent control center | multi-agent/session dashboard (terminal/browser/git/MCP) | orchestration dashboard | High | Verify | folds into §3.8 lanes | P2 |
| **Kiro/Antigravity (artifacts)** | Spec/plan | Implementation Plan, Walkthrough w/ screenshots, inline comments | pre-flight plan card + receipt w/ screenshot | Med | Concept only | benchmark Top6/Top8 (planned); L2 receipt uses CDP screenshot | P1/P2 (planned) |
| **Dyad / bolt.diy** | App builder | onboarding, file locking, snapshots, conflict prevention | snapshots + single-flight edit lock | Low (planned) | Apache/MIT (verify) | edit single-flight in subagent doc; **reject** generic-builder onboarding | non-goal / P2 |

---

## 6. Implementation plan by package / files

Grounded in current paths; confirm at implementation. New files marked **NEW**.

### shared/ (typed contracts first — keep boundaries explicit)
- `shared/stage-overlay.ts` **NEW** — `RuntimeHighlight` type.
- `shared/runtime-timeline.ts` **NEW** — `RuntimeEvent` union + pure merge/dedup
  helpers (import-free, reusable across main/renderer/tests, like
  `runtime-evidence.ts`).
- `shared/ipc.ts` — add `stage:highlight` (event), `runtime:timeline` (event),
  `runtime:timeline-pull` (invoke); update `IpcMapIsComplete` / `EVENT_CHANNELS`.
- `shared/capture.ts` — **no change** for §3.2 (element kind exists); confirm.
- `shared/agent.ts` — add `Checkpoint` + supervisor projection fields (read-only)
  to `AgentChatState`; later `Lane`/`LaneSummary` for §3.8.
- `shared/remote.ts` — checkpoints/lanes ride the existing snapshot (no new
  event), mobile renders only.

### electron/ (main process)
- `electron/inspect-overlay.ts` — accept agent-driven highlight requests;
  selector/`backendNodeId` → box via CDP (`DOM.getBoxModel` / `Overlay.*`).
- `electron/browser/cdp.ts` — ensure highlight CDP methods are in
  `isAllowedCdpMethod`; emit highlight + timeline events from the message listener.
- `electron/browser/state.ts` — extend the per-tab buffers to feed the timeline
  merger (errors already here).
- `electron/browser/timeline.ts` **NEW** — merge console buffer + network
  failures + agent-action + reload-verify into `RuntimeEvent[]`; coalesced emit.
- `electron/browser/handlers.ts` — `runtime:timeline-pull` handler (validate
  web `tabId`), via `ipc/define-handler.ts` + `ipc/validate.ts`.
- `electron/agent/tools/executors.ts` — browser tool executors emit
  `stage:highlight` + a timeline `agent-action` row around each page action;
  gated browser actions emit a *pre*-highlight for §3.12 preview.
- `electron/agent/loop.ts` — checkpoint capture hook (source snapshot + runtime
  marker) before edit-bearing turns / gated browser mutations.
- `electron/llm.ts` (+ runtime-evidence boundary) — network "triage" `kind`
  branch (§3.4), reusing scrub.
- `electron/git-worktree.ts` (exists) + `electron/git.ts` — worktree
  create/list/remove already present; extend for §3.8 lanes (Later).

### src/ (renderer)
- `src/features/browser/BrowserStageOverlays.tsx` — extend (don't duplicate) to
  render agent `RuntimeHighlight[]` (keyed by tabId) via
  `useIpcListener('stage:highlight')`, alongside today's user-pick overlay.
- `src/features/browser/StageInspectToolbar.tsx` **NEW** — floating element pick
  toolbar (§3.2), reuses `features/context/CaptureCard.tsx`.
- `src/features/devtools/` — add `EvidenceTimeline.tsx`; promote the dock to host
  the timeline as its spine; jump handlers into existing panels.
- `src/features/context/ContextDrawer.tsx` — segmented Transcript|Supervisor;
  `SupervisorRail.tsx` + `ApprovalBadge.tsx` + `PageActionLog.tsx` **NEW**.
- `src/features/agent/AgentChat.tsx` — checkpoint list + restore action; provenance
  link from edit cards to timeline (§3.9 addition).
- `src/components/ActivityBar.tsx` + `src/features/lanes/` **NEW** — Lanes view
  and board (§3.8, Later).
- `src/views/Shell.tsx` — wire the Evidence dock (bottom drawer) + layout preset
  selector; keep the default grid path untouched.

### mobile/ & relay/
- No protocol additions: checkpoints/lanes/supervisor projection ride the existing
  `AgentChatState` snapshot. Keep `relay/ws/hub.ts` payload-agnostic; `mobile/`
  renders the new fields read-only (no local logic — package boundary).

### Verification per step (AGENTS.md)
- After each shared/IPC change: `cd marudesk && npm run typecheck`.
- Main-process: targeted `npm run harness:*` (add `harness:timeline`/overlay
  resolver where pure logic warrants it).
- Renderer: `npm run build` + real-UI smoke (exercise highlight on a live page,
  capture an element, drive a fake-agent click and watch the timeline).
- e2e: `npm run e2e` for the highlight-on-tool-call and capture-to-composer flows.

---

## 7. Open questions

1. **Layout preset vs. always-on docks.** Should the Evidence dock + Supervisor
   mode be a selectable "Runtime/Debug" preset (recommended, preserves the grid)
   or always available toggles? (§2)
2. **Timeline default filter.** Errors + agent-actions + navigations only, with
   network successes opt-in (mirrors passive-`Runtime`-only)? Confirm noise budget.
3. **Highlight under single-CDP contention.** Degrade silently when Chrome
   DevTools is attached (current console-capture behavior) — acceptable for v1?
4. **Checkpoint runtime restore scope.** Navigation + scroll only in MVP; how far
   to chase SPA/form/storage restore before it becomes unreliable? (§3.6)
5. **Lanes vs. companion framing.** Worktree isolation conflicts with "patches
   your real folder." Default lane = user folder, worktree opt-in — agreed? (§3.8)
6. **Element source-jump promise.** Keep strictly "candidate with confidence"
   (roadmap §7) even as Onlook/stagewise imply exactness?
7. **Overlap governance.** Supervisor rail (single-session, page-focused) vs.
   Mission Control (multi-session board) vs. v6 Taskboard — confirm the three
   stay distinct lenses over one snapshot, not three state trees.
8. **Doc consolidation.** Should §3.9/§3.10/§3.11 fold back into v6 to avoid two
   docs owning diff/spec/MCP UX?

---

## 8. Risks & non-goals

### Risks
- **Snapshot multiplication.** Page highlights, timeline, supervisor, lanes each
  tempt a new state channel. Mitigation: highlights/timeline are *runtime*
  channels keyed by `tabId` (separate from agent state); everything agent-derived
  stays a projection of the single `AgentChatState` (subagent/background invariant).
- **Overlay correctness.** Box drift, z-order, cross-origin frames. Mitigation:
  recompute on scroll/resize, short TTL, degrade silently.
- **Scope creep into chat re-design.** Much is already planned in v5/v6.
  Mitigation: this doc owns only the runtime/browser layer; cross-ref the rest.
- **Single-CDP-client.** Chrome DevTools escape hatch detaches our capture
  (roadmap §10). Mitigation: re-attach on next nav; surface state honestly.
- **Honesty of source mapping.** Element/DOM → source is best-effort.
  Mitigation: confidence-tagged candidates, never "exact line."

### Non-goals (explicit)
- **Generic app builder / scaffolding onboarding** (Dyad/bolt.diy). MaruDesk is a
  web-debugging workstation with an agent inside it, not a project generator.
- **Live visual CSS/design editing** (Onlook/Cursor Visual Editor/Lovable).
  `css-source.ts` maps same-origin static CSS only; visual editing over-promises
  (roadmap §2). The element inspector is a debugging + agent-context aid.
- **Multi-user collaboration / shared threads** (openagent). Single-user scope
  (v6 §E).
- **Full DevTools parity** — debugger, breakpoints, device emulation, profiler,
  waterfall clone (roadmap §8). Hand off to real Chrome DevTools when needed.
- **Cloud-distributed agent execution.** Lanes are local worktrees, not remote
  runners (subagent §11).
- **A second accent / new color tokens.** All new surfaces use existing tokens;
  AI-timeline colors stay restricted to agent-state rows (`DESIGN.md` §2/§7).

---

## 9. Design principles (for everything above)

1. **The running app is the differentiator.** Prefer features only possible
   because MaruDesk owns the browser + CDP. When a feature is "just chat UX,"
   defer to v5/v6.
2. **Every agent action is visible, on the page.** If the agent touches the DOM,
   it highlights it; if it changes the app, it lands on the timeline.
3. **Reversible and source-tied.** Runtime evidence links to the edit it caused;
   edits link to the checkpoint that can undo them.
4. **One snapshot, many lenses.** Supervisor, timeline rows, lanes are projections
   — don't fork agent state.
5. **Dense, fast, low-drama.** Drawers coexist with the stage (no backdrop), 120/
   200ms motion, tabular nums, tokens only, Lucide stroke 1.5, no emojis/celebration
   (`DESIGN.md`).
6. **Honest about uncertainty.** Source candidates carry confidence; best-effort
   restores say so. Never claim exactness the runtime can't guarantee.

---

**Verified against:** `Shell.tsx`, `App.tsx`, `tokens.css`, `DESIGN.md`,
`roadmap.md`, `design-benchmark-2026-06.md`, `agentic-chat-v5/v6`, `subagent`,
`background-agent`, `context-mcp` (2026-06-08). Re-confirm file:line at
implementation.
