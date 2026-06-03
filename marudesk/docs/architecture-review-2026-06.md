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

## Second pass — modularization (done, verified)

A follow-up pass took the backlog's pure-reorganization items. Each is behavior-
preserving and verified by typecheck/build (and the MCP harness where relevant).

- **P1 — `electron/agent/tools.ts` → `tools/`.** The 1060-line file became a
  folder with a barrel that preserves the `./tools` import surface:
  `types.ts` (shapes + tool-name sets), `executors.ts` (executors + `executeTool`
  + `describeToolInput`), `schemas.ts` (the JSON-Schema list), `registry.ts` (the
  MCP descriptor layer). Verified by the MCP harness (39/39).
- **P1 — reasoning config out of `loop.ts`.** The pure reasoning-effort →
  provider-option helpers (`buildProviderOptions`, `maxTokensForTurn`, the
  Anthropic budget map) moved to `agent/reasoning-config.ts`.
- **P2 — console autocomplete out of `devtools/store.ts`.** The completion
  cluster (Command Line API list, `parseCompletionContext`, member/global CDP
  lookups, `rankCompletions`, the `Completion*` types) moved to
  `devtools/console/completion.ts`; the store re-exports the types so
  `ConsoleInput` is unchanged. (CSS-edit helpers were already in `css-source.ts`.)
- **P3 — `src/hooks/`.** Added `useIpcListener`, `useElapsedTimer`/`formatElapsed`,
  `useCountdown`; `AgentChat`/`SettingsView` now import the timer hooks instead of
  defining them locally, and the two duplicate status-subscription effects in
  `SettingsView` use `useIpcListener`.

## Prioritized backlog (still open — needs focused, test-backed work)

These touch large files' runtime behavior (or stateful turn logic) and deserve
their own change with manual UI/harness verification, so they were deliberately
left for a focused pass:

### P1 — the rest of the agent loop

- `electron/agent/loop.ts` still owns the approval gate (parking, gated-tool
  filtering, "allow always") interleaved with live turn state. Extracting
  `agent/approval-gate.ts` + a turn executor needs the resolvers and in-flight
  state moved together and is best done with the agent harness driving a real
  turn — not a blind reorg.

### P2 — split the oversized renderer surfaces

- `src/features/devtools/store.ts` (~2180 after the console split) — lift DOM
  indexing/traversal into `devtools/dom/` next.
- `src/features/agent/AgentChat.tsx` (~2100) → `AgentChat/` folder
  (`MessageView`, `SlashMenu`, `ContextPopover`, `Composer`).
- `src/features/settings/SettingsView.tsx` (~1830) → category subfolders
  (`Appearance`, `Remote`, `Data`, `About`).

### P3 — remaining commonization

- Shared `StatusDot` and a `SegmentedControl` (one exists inline in Settings) to
  replace repeated inline variants.
- `electron/` shared error helpers (`wrapError`, `assertNotNull`) for the mixed
  catch/throw/return-`{ok}` patterns.

### P4 — structure polish

- `electron/workspace/` and `electron/server/relay/` subdirectories to group the
  files currently flat at those roots. Note: the relay group is fiddlier than it
  looks — `relay-bridge-harness.ts` resolves `RELAY_DIR` from `import.meta.url`,
  so a move must re-derive that path. Pure cosmetics; do it only alongside other
  relay work.
- `mobile/PROTOCOL.md` documenting the relay/host frame layering, plus a
  round-trip test for `relay-frames.ts` parsers against known wire samples to
  catch drift from `marudesk/shared/remote.ts`.

## Guardrails (keep doing)

- All IPC channels go through `ipc/define-handler.ts` + `ipc/validate.ts`.
- New providers = one file implementing `ProviderDriver` + one registry entry in
  `providers/index.ts`. No switch statements.
- `relay/ws/hub.ts` stays payload-agnostic and account-scoped.
- Colors only via `src/styles/tokens.css` / `tailwind.config.ts`.
