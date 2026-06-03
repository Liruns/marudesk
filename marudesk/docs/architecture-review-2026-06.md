# Architecture Review & Refactoring Roadmap (2026-06)

A whole-repo structural review of the three packages (`marudesk/`, `mobile/`,
`relay/`) covering folder structure, modularization, commonization, performance,
and extensibility. It records what is already strong, what was changed in this
pass, and a prioritized backlog for the larger refactors that need their own
focused, test-backed change.

## Verdict by package

| Package | State | Headline |
| --- | --- | --- |
| `relay/` | Strong | Clean composition root; `ws/hub.ts` is a dumb account-scoped pipe; crypto (`jwt`/`password`/`safe`) is isolated and constant-time. No structural changes needed. |
| `mobile/` | Solid | Clean `Transport` seam with three interchangeable implementations and a last-value emitter. Watch protocol drift in `transport/relay-frames.ts` (hand-kept copy of the host wire format). |
| `marudesk/` | Good, scaling pains | Feature-based renderer + domain-scoped `electron/`. The standout is the `ipc/define-handler.ts` + `ipc/validate.ts` abstraction (single source of truth for ~50 channels). Pain is concentrated in a handful of oversized files. |

## What this pass changed (safe, verified)

All changes below typecheck across the three packages and `marudesk` builds clean.

- **Commonization — shared `CopyButton`.** Two divergent stateful copy buttons
  (`AgentChat` message copy, `SettingsView` URL copy) collapsed into one
  `src/components/ui/CopyButton.tsx` with `sm`/`md` sizing and an optional
  `write` override (the desktop window routes through the
  `clipboard:write-text` IPC bridge instead of `navigator.clipboard`).
- **Performance — memoize the transcript.** `MessageView` and `ToolCardView` in
  `AgentChat.tsx` are now `React.memo`. Composer keystrokes (and streaming ticks
  on the live message) no longer re-render every prior message. The `@file`
  mention scoring (`matchFiles` over the whole workspace index) and the slash
  menu filter are now `useMemo`'d off the unrelated render path.
- **Modularization — workspace config.** Indexer tunables and lexical sets
  (`MAX_FILES`, `INDEXABLE_EXTENSIONS`, `IGNORE_DIRS`, `COMMON_TAGS`,
  `STOP_WORDS`, …) moved out of the 600-line `electron/workspace.ts` into
  `electron/workspace-config.ts`; `search.ts` now shares `IGNORE_DIRS` from
  there instead of reaching into the indexer module.
- **Extensibility — transport contract.** Documented the intentional
  `Transport.connect()` asymmetry in `mobile/src/transport/types.ts` (relay
  credentials are relay-only; `DirectTransport` uses constructor `DirectCreds`).

## Prioritized backlog (needs focused, test-backed work)

These are intentionally **not** done in this pass: each touches a large file's
runtime behavior and deserves its own change with manual UI/harness verification.

### P1 — split the agent core

- `electron/agent/loop.ts` (~1305 lines) mixes the turn loop with the approval
  gate, reasoning-effort/provider-option assembly, and the tool-execution
  sub-loop. Extract `agent/approval-gate.ts`, `agent/reasoning-config.ts`, and a
  turn executor. Enables reuse from the bridge dispatcher (`server/dispatch.ts`).
- `electron/agent/tools.ts` (~1060 lines) — pure reorg into `tools/executor.ts`
  (executors + `executeTool`), `tools/schemas.ts` (schemas + gated/ask defs),
  `tools/mcp.ts` (MCP defs + tool-group name sets), with `tools.ts` kept as a
  barrel. No logic change; verify via the MCP/agent harnesses.

### P2 — split the oversized renderer surfaces

- `src/features/devtools/store.ts` (~2440) — lift console autocomplete, CSS-edit
  helpers, and DOM indexing into `devtools/{console,css,dom}/` modules; the
  store keeps state, the helpers become unit-testable.
- `src/features/agent/AgentChat.tsx` (~2113) → `AgentChat/` folder
  (`MessageView`, `SlashMenu`, `ContextPopover`, `Composer`).
- `src/features/settings/SettingsView.tsx` (~1849) → category subfolders
  (`Appearance`, `Remote`, `Data`, `About`).

### P3 — commonization & boilerplate

- `src/hooks/` for the repeated patterns: a typed `useIpcListener`, `usePrevious`
  (the store-previous-prop fields in Settings), and the scattered
  `useElapsedTimer`/`useCountdown`. (Note: the already-batched event hooks
  `useTabEvents`/`useDevtoolsEvents` intentionally group their subscriptions and
  should stay as-is.)
- Shared `StatusDot` and a `SegmentedControl` (one exists inline in Settings) to
  replace repeated inline variants.
- `electron/` shared error helpers (`wrapError`, `assertNotNull`) for the mixed
  catch/throw/return-`{ok}` patterns.

### P4 — structure polish

- `electron/workspace/` and `electron/server/relay/` subdirectories to group the
  files currently flat at those roots.
- `mobile/PROTOCOL.md` documenting the relay/host frame layering, plus a
  round-trip test for `relay-frames.ts` parsers against known wire samples to
  catch drift from `marudesk/shared/remote.ts`.

## Guardrails (keep doing)

- All IPC channels go through `ipc/define-handler.ts` + `ipc/validate.ts`.
- New providers = one file implementing `ProviderDriver` + one registry entry in
  `providers/index.ts`. No switch statements.
- `relay/ws/hub.ts` stays payload-agnostic and account-scoped.
- Colors only via `src/styles/tokens.css` / `tailwind.config.ts`.
