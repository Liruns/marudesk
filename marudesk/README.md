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
runtime capture, model/provider configuration, and patch application. The mobile
client and relay should treat the PC host as the owner of that state.

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

Use targeted harnesses when changing main-process or server behavior:

```bash
npm run harness:server
npm run harness:e2e
npm run harness:pair
npm run harness:relay-bridge
npm run harness:mcp
npm run harness:plugins
npm run harness:plugin-lifecycle
npm run harness:orchestration
npm run harness:search
npm run harness:prompt-injection
```

## Architecture notes

- `electron/browser/*` owns browser tabs, navigation, downloads, DevTools wiring,
  and CDP-facing runtime capture.
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

- `../relay`: auth and same-account host/client WebSocket relay.
- `../mobile`: Capacitor thin client that renders PC-owned agent state.
