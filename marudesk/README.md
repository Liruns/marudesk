# marudesk

`marudesk` is the Electron desktop app in this workspace. It combines a browser
stage, custom DevTools surfaces, workspace-aware patch review, terminal/editor
panels, and an agent chat loop that can use runtime evidence instead of guessing
from source files alone.

## What lives here

- Electron main process code in `electron/`
- React renderer code in `src/`
- Shared typed contracts in `shared/`
- Playwright end-to-end tests in `e2e/`
- Product and architecture notes in `docs/`
- Design system rules in `DESIGN.md`

The desktop app is the only package that owns local workspace access, browser
runtime capture, model/provider configuration, and patch application. A local
terminal client reaches the same agent loop over the loopback CLI bridge and
treats the PC host as the owner of that state. The former Capacitor mobile
client is archived on the `archive/mobile` branch and removed from the active
workspace.

## Stack

- Electron 42 (Chromium 148)
- React 19 + Vite 8
- TypeScript 6 in strict project builds
- Tailwind tokens backed by `src/styles/tokens.css`
- Playwright for Electron/runtime end-to-end coverage
- Provider integrations through the AI SDK and provider-specific adapters
- Local persistence: app settings/secrets/config as JSON, AI Chat sessions in a
  SQLite store (`better-sqlite3`, with full-text search) that falls back to JSON

## Run locally

```bash
npm install
npm run dev
```

`npm run dev` starts the Vite renderer and Electron shell for local desktop
development.

`better-sqlite3` is a native module (like `node-pty`). If the SQLite session
store reports it fell back to JSON (Settings → Data & Storage), rebuild the
native binaries against Electron's ABI:

```bash
npm run rebuild:native
```

## Verification

```bash
npm run typecheck
npm run build
npm run e2e
```

## Chat from the terminal

The bundled chat CLI (docs/chat-cli-tui-design.md) is an OpenCode-style
terminal UI over the same agent loop: a bordered header card, a full-width
status bar (state · workspace · approval mode on the left, model · context ·
tokens on the right), streamed markdown + reasoning, tool lines, a sticky
composer with a slash menu (`/model`, `/sessions`, `/new`, `/review`,
`/agents`, `/skills`, …), inline approval/question panels, Esc to interrupt.
The app always runs a loopback companion bridge while it's open, so this works
with zero configuration:

```bash
npm run chat                                   # interactive TUI
npm run chat -- --prompt "explain this repo"   # one-shot (plain output)
npm run chat -- --line                         # plain line-mode REPL
```

A model is picked interactively on first run (`/model` later) and remembered;
`--provider/--model` set it explicitly. The companion drops a same-user
`cli-bridge.json` handshake under userData while the app runs; `--url` /
`--token` (or `MARUDESK_BRIDGE_URL` / `MARUDESK_BRIDGE_TOKEN`) target another
bridge instead. Over the loopback companion the CLI is a full chat surface,
gated-tool approvals included — the loopback origin plus the bearer token is the
trust boundary (same-user trust).

In the app itself the CLI is an always-available sibling of the chat panel:
the Home view's **AI Chat (CLI)** launcher opens an "AI Chat (CLI)" terminal
tab hosting this CLI. The app also installs a `marudesk` command on PATH at
boot (Settings → Terminal shows/repairs it), so any terminal can run the chat
CLI while the app is running.

## Agent roles & skills

Delegated subtasks (`spawn_subagent` / `spawn_background_agent`) run as named
roles. Built-ins: `explore`, `researcher`, `reviewer`, `planner`, `general`
(`list_agents` shows the catalog; docs/subagent-design.md has the design).
Define your own as markdown files — `<userData>/agents/<name>.md` (user) or
`<workspace>/.marudesk/agents/<name>.md` (project; shadows user/builtin):

```markdown
---
description: Writes API documentation from source.
model: fast            # fast | smart | inherit | <provider>/<model>
tools: read_file, list_files, grep
---
You are a documentation writer. Read the relevant source and produce…
```

The role's model preference resolves against the providers you actually
connected (tier → concrete model per provider), and a rate-limited/erroring
provider fails over down the chain mid-run — same rules as the main loop's
model fallback. Tool lists only ever narrow the child-safe read-only toolset.
Reusable instruction **skills** live next door (`skills/<name>/SKILL.md`) and
load on demand through the `skill` tool.

## Verification harnesses

Use targeted harnesses when changing main-process or server behavior. To run
the whole headless-harness suite with one summary, use the runner (it
auto-discovers every `harness:*` script; `--only <substr>` filters, `--list`
shows the curation):

```bash
npm run harness:all
```

Individual harnesses:

```bash
npm run harness:server
npm run harness:cli
npm run harness:bookmarks
npm run harness:mcp
npm run harness:plugins
npm run harness:plugin-lifecycle
npm run harness:orchestration
npm run harness:search
npm run harness:prompt-injection
```

## Architecture notes

- `electron/browser/*` owns browser tabs, navigation, downloads, bookmarks
  (`bookmarks-core.ts` persisted to `userData/bookmarks.json`, covered by
  `npm run harness:bookmarks`), DevTools wiring, and CDP-facing runtime capture.
  The renderer's library panel (`src/features/browser/BrowserLibraryPanel.tsx`,
  Ctrl/Cmd+Shift+O) surfaces bookmarks and full browsing history. The custom
  DevTools dock includes a Sources panel (Debugger-domain breakpoints, stepping,
  call stack, scopes, lightweight syntax highlighting, source-map original-source
  restoration, XHR/event-listener breakpoints, watch expressions), a Performance
  panel (live metrics + CPU profiler with top-down/bottom-up views), a Security
  panel (connection/certificate state; certificate-bypass CDP methods stay
  blocked), Elements event-listeners/accessibility/fonts panes + DOM editing +
  grid/flex overlays, Application-panel IndexedDB / Cache Storage / quota /
  manifest / frames / service-worker inspection, Network HAR export,
  copy-as-fetch, WebSocket/SSE message inspection, initiator + cookies tabs,
  and JS/CSS coverage in the Rendering panel.
- `electron/workspace-*.ts`, `shared/workspace.ts`, and
  `src/features/workspaces/*` own the multi-workspace deck: named workspaces,
  multiple folder roots per workspace, workspace split panes, workspace-scoped
  tabs, focused-root Explorer sync, and pane-local Peek Explorer. The deck rail
  manages workspace lifecycle from the UI — create, rename, reindex, delete, and
  per-root removal.
- `electron/ssh/*` and `shared/ssh.ts` add **remote SSH workspace roots**: a
  folder on another host can be added as a workspace root and indexed/opened/
  edited over SFTP. A remote root is identified by an `ssh://<connId><path>` key
  that the file-op entry points route to the SFTP backend; `electron/ssh/sftp.ts`
  re-expresses fs-safe's path contract (relative-only, no traversal, symlink-
  refused) for POSIX/SFTP. Connections (key file / password / SSH agent) are
  managed via the `ssh:*` IPC channels; credentials stay in the main process and
  never return to the renderer. Add one from a workspace pane's **Add SSH folder**
  button (`src/features/workspaces/SshRootDialog.tsx`). Indexing prefers
  `git ls-files` over SSH and falls back to an SFTP walk. Remote deletes are
  permanent (no host trash); Save As, Reveal, and the agent's workspace file
  tools remain local-only for now. Host keys are accepted on first sight (no
  known_hosts pinning yet — see the SECURITY TODO in `connection-manager.ts`).
- `electron/agent/*` owns agent session orchestration, MCP tool plumbing, context
  sources, and model loop behavior. Built-in context tools include workspace
  read/list helpers so an agent can inspect non-focused workspace roots without
  changing the user's active Explorer root.
- `electron/search.ts` owns workspace content search (`search:content`),
  preferring ripgrep and falling back to a Node walk; its pure helpers — glob
  filtering, the per-line matcher, byte→char offset conversion, and preview/range
  building — live in `electron/search-core.ts` and are covered by
  `npm run harness:search`. The renderer slice is `src/features/search/*`.
- `shared/*` contains transport-safe contracts used across Electron, renderer,
  tests, and companion surfaces.
- `src/features/*` contains renderer feature slices for browser, DevTools,
  editor, workspace, patch review, settings, git, terminal, and agent chat.
- Local data is hybrid: settings (`electron/settings.ts`), secrets, MCP config,
  and history stay JSON; AI Chat sessions live in `electron/db.ts` (SQLite) via
  `electron/agent/sessions-store.ts`, which migrates legacy `sessions/*.json` on
  first run and degrades to the JSON layout when the native module is
  unavailable. Settings → **Data & Storage** manages what persists (chat
  sessions, tab restore), shows usage, and can clear sessions or reveal the data
  folder.

Keep runtime evidence flows typed and narrow. If a value crosses from browser
runtime to agent prompt or patch application, make the boundary explicit in
`shared/` or the relevant IPC contract.

## Design rules

Follow `DESIGN.md` and `src/styles/tokens.css`.

- Do not hard-code colors in JSX.
- Keep the app dark-first, restrained, and operational.
- Use Lucide React for UI icons.
- Reserve AI timeline colors for AI activity states only.
- Keep copy precise and calm; no emojis or celebratory status text.

## Related packages

The `../mobile` Capacitor thin client is archived (`archive/mobile` branch, tag
`archive/mobile-v0.8.0`) and is no longer part of the active workspace.
