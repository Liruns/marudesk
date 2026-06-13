<p align="center">
  <img src="marudesk/src/assets/logo-full.png" alt="Maru" width="360">
</p>

<p align="center">
  <strong>An infinite canvas where AI sees your <em>running</em> app — not just your source.</strong><br>
  A desktop app that arranges a real web browser, a code editor and terminal, and a multi-provider AI agent as freeform cards on a pannable, zoomable canvas.
</p>

<p align="center">
  <a href="https://github.com/Liruns/marudesk/releases/latest"><img src="https://img.shields.io/github/v/release/Liruns/marudesk?sort=semver&label=release&color=5b8def" alt="Latest release"></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-444" alt="Platforms">
  <a href="https://github.com/Liruns/marudesk/releases"><img src="https://img.shields.io/github/downloads/Liruns/marudesk/total?label=downloads&color=5b8def" alt="Downloads"></a>
  <img src="https://img.shields.io/badge/Electron-42-47848F?logo=electron&logoColor=white" alt="Electron 42">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Liruns/marudesk?color=444" alt="License: MIT"></a>
</p>

<p align="center">
  <img src="docs/home.png" alt="Maru — the new-tab shell with the activity bar, explorer, and surface cards" width="860">
</p>

Maru is a desktop application (Electron) for building and debugging web software. Unlike source-only AI coding tools, it embeds a real Chromium browser and speaks the Chrome DevTools Protocol (CDP) in-process, so the agent can read the live DOM, console, and network of the app you are running and act on that runtime evidence — for example, turning a console error into a source fix and confirming the fix by reloading the page.

> Status: in active development — built as a daily driver and portfolio project. See [Project status](#project-status).

## Download

Grab the installer for your platform from the **[latest release →](https://github.com/Liruns/marudesk/releases/latest)**.

| Platform | Installer | Notes |
|---|---|---|
| **Windows** | [`marudesk-Setup-0.2.0.exe`](https://github.com/Liruns/marudesk/releases/download/v0.2.0/marudesk-Setup-0.2.0.exe) | Installs and auto-updates in place. |
| **macOS** · Apple Silicon | [`marudesk-0.2.0-arm64.dmg`](https://github.com/Liruns/marudesk/releases/download/v0.2.0/marudesk-0.2.0-arm64.dmg) | Unsigned — on first launch, right-click → **Open** to pass Gatekeeper. |
| **macOS** · Intel | [`marudesk-0.2.0.dmg`](https://github.com/Liruns/marudesk/releases/download/v0.2.0/marudesk-0.2.0.dmg) | Unsigned — on first launch, right-click → **Open**. |
| **Linux** | [`.AppImage`](https://github.com/Liruns/marudesk/releases/download/v0.2.0/marudesk-0.2.0.AppImage) · [`.deb`](https://github.com/Liruns/marudesk/releases/download/v0.2.0/marudesk_0.2.0_amd64.deb) | `chmod +x` the AppImage and run it, or `sudo dpkg -i` the `.deb`. |

Prefer to build from source? See [Getting started](#getting-started).

## The idea

Most AI coding assistants only see your source files. Maru co-locates the surfaces a developer actually moves between — browser, DevTools, editor, terminal, and the agent — inside one process, and connects the *seams* between them:

- A console error in the embedded DevTools carries a one-click **Fix this**: the agent maps the stack frame back to your source file, edits it, reloads the page, and verifies the error is gone (`get_console_errors → edit → reload_and_verify`).
- The agent can click, type, and scroll the live page, read network requests, and evaluate expressions — the same things you would do by hand in DevTools.
- Because the agent shares the workspace, terminals, and open tabs through an in-process context server, it works from what is actually on screen instead of guessing.

## Screenshots

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/ai-chat.png" alt="Agentic AI chat surface"><br>
      <sub>Agentic AI chat — model bar, session-history rail, reasoning-effort dial, and the agent composer.</sub>
    </td>
    <td width="50%" valign="top">
      <img src="docs/split-view.png" alt="Tabs tiled in a split-pane grid"><br>
      <sub>Tabs-as-features on a split-pane grid — browser, editor, terminal, and agent side by side.</sub>
    </td>
  </tr>
</table>

## Features

### Agentic AI chat
- **Many providers, one app.** Anthropic, OpenAI, Google (Gemini), xAI (Grok), Ollama (local), and any custom OpenAI-compatible endpoint (OpenRouter, LM Studio, vLLM, and similar).
- **Bring your own subscription.** Connect by API key, or sign in with an OAuth subscription. Claude (Pro/Max) and xAI work today; ChatGPT and Gemini subscription backends are experimental.
- **Provider fallback chain.** When the active model is rate-limited or errors (429 / 5xx), the agent automatically retries on the next connected model you have ranked, instead of failing the turn.
- **Streaming, reasoning, and control.** Live token streaming, collapsible reasoning blocks, a per-provider reasoning-effort dial, and approval modes (plan / read-only / ask / auto).
- **Composer that keeps up.** Slash commands (`/init`, `/review`, `/diff`, `/context`, `/compact`, `/copy`, …), `@`-mention workspace files, paste or drop images for vision models, recall past prompts with the arrow keys, and queue a message while a turn is still running.
- **Plan mode.** Have the agent research read-only and propose a step-by-step plan before you let it edit.
- **Compaction and verify.** `/compact` summarizes a long conversation to reclaim context; an optional post-edit verify command (e.g. `npm run typecheck`) runs after the agent edits and folds the PASS/FAIL back into the chat.
- **Approvals that remember.** Approve a gated tool once, or "Allow always" to stop re-prompting for it for the rest of the conversation.
- **Sessions and memory.** Resume past conversations from a history rail; keep durable cross-session notes.
- **Chat from the terminal.** An OpenCode-style CLI (`npm run chat` in `marudesk/`) drives the same agent over a zero-config loopback bridge — a bordered header card, a full-width status bar (state · workspace · mode on the left, model · context · tokens on the right), streamed markdown and reasoning, a slash menu, model/session pickers, `/agents` and `/skills` catalogs, inline approvals, Esc to interrupt. In the app it lives alongside the chat panel as an "AI Chat (CLI)" terminal tab (Home launcher), and the app installs a `marudesk` command on PATH so any terminal can open it while the app runs (Settings → Terminal shows/repairs it).
- **Agent roles + skills.** Delegated subtasks run as named roles: built-in agents (`explore`, `researcher`, `reviewer`, `planner`, `general`) plus your own, defined as markdown files under `.marudesk/agents/` (project) or the app's `agents/` folder (user) — frontmatter picks the model (`fast`/`smart` tier or a concrete `provider/model`) and a tool subset, the body is the role's instructions. The subagent's model resolves automatically against the providers you actually connected, and fails over mid-run on rate limits the same way the main loop does. Reusable instruction **skills** (`SKILL.md` playbooks) load on demand via the `skill` tool.

### Runtime-aware tools (the differentiator)
- Read console errors with **source mapping** back to workspace files.
- Query the DOM, read network requests and response bodies, evaluate JavaScript.
- Drive the live page: click, fill, press keys, scroll.
- A **reload-and-verify** loop that checks whether a change actually removed the error.
- **See the page**: a `screenshot` tool hands the live viewport to vision-capable models, so the agent can verify a change *looks* right, not just that the error is gone; `get_web_vitals` grounds performance claims in LCP/CLS/INP/TTFB.
- An **exception trap** (`arm_exception_capture` → reproduce → `read_exception_capture`) that snapshots call frames and local variable values at the moment an uncaught exception fires.
- **Full-stack triage**: `triage_network_failure` correlates a failed request with backend dev-server output across multi-root (FE+BE) workspaces.
- One-click **Fix this** on console errors — and on **terminal errors**: build/test failures detected in integrated terminal scrollback get a badge and the same one-click handoff to the agent.

### A real browser, not a preview
Tabbed browsing on a split-pane grid, with favicons, history, **bookmarks** (star toggle + panel), **address-bar suggestions** (bookmarks and frecency-ranked history with a search-the-web row), **tab groups** (named, colored, collapsible, session-restored), downloads, find-in-page, zoom, configurable search engines, crash recovery, and per-site partitioning.

### Custom DevTools (CDP)
A React-built DevTools dock with Console, Network, Elements, Application, and Rendering panels plus a REPL — dockable or popped out into its own window. Network requests open into full detail tabs (**Headers / Payload / Response / Timing / Initiator**) with parsed payloads and phase timing bars; **WebSocket/SSE connections get a live Frames viewer**; the Application panel can **edit local/session storage and delete cookies**; Elements adds a **Computed pane with the box-model diagram**. Chromium's own DevTools remain available as an escape hatch.

### Editor, terminal, explorer
A Monaco code editor with **TypeScript/JavaScript IntelliSense** (completions, hover, go-to-definition across open files), **format on save**, a **git diff gutter**, and **inline current-line blame**; a real shell terminal (node-pty) with find, copy/paste, and **error detection with one-click Fix this**; a file explorer; and workspace-scoped file tools the agent can use — guarded by configurable never-edit globs. The Source Control panel covers stage/commit/branch/sync plus **stashes** (push/apply/pop/drop) and **merge-conflict resolution** (per-file accept ours/theirs, operation banner with Continue/Abort, and accept-current/incoming/both codelenses on conflict markers in the editor). Workspace **content search** (Ctrl/Cmd+Shift+F, ripgrep with a Node fallback) adds case/word/regex toggles, include/exclude glob filters, highlighted match previews, and click-to-jump to the exact line and column.

### Context MCP and external MCP
A built-in, in-process MCP server exposes tabs, the active page, terminals, editor buffers (including unsaved edits), the explorer tree, sessions, and memory to the agent. External MCP servers can also be connected — local over **stdio** or remote over **HTTP** (Streamable HTTP, with an SSE fallback) — configured Claude-Desktop-style in `mcp-servers.json`. Each external tool is routed through the same approval / read-only mediation as the built-in ones; a server can be marked `trust`, hidden per tool with `disabledTools`, auto-approved per tool with `autoApproveTools`, or forced back to per-call confirmation with `confirmTools`. Config reads report diagnostics and fail closed on malformed config, and external tool names/metadata/schema are scrubbed and bounded before model exposure. Manage them in Settings → MCP Servers.

### Plugins
Extend the agent with your own JavaScript. A plugin is a folder with a `manifest.json` and an `index.js` exporting `activate(ctx)`; it can contribute **agent tools** and **slash commands**. Plugins run in an **isolated worker** (Electron `utilityProcess` with the Node Permission Model + a module sandbox), never in the main process, and reach the filesystem/network only through a **capability-gated bridge** the user approves per plugin (`fs:read`, `fs:write`, `net`). Contributed tools flow through the same approval / read-only mediation as the built-in ones, and a plugin's file writes show up in the chat diff/revert history. Manage them in **Settings → Plugins**; see [`marudesk/docs/plugin-runtime-design.md`](marudesk/docs/plugin-runtime-design.md). Plugin folders are scanned from `<userData>/plugins/` (user) and `<workspace>/.marudesk/plugins/` (project); a runnable example lives in [`marudesk/examples/plugins/hello-world`](marudesk/examples/plugins/hello-world).

### Remote / mobile bridge
Drive your PC's agent from your phone. QR-code pairing, application-level end-to-end encryption (X25519 + AES-GCM), direct LAN / Tailscale transport, and an optional cloud relay for access from anywhere. Direct mode works **fully self-hosted across networks**: the pairing QR carries every reachable address (a stable Public URL, the managed auto-tunnel, Tailscale, then LAN) and the phone fails over between them automatically. Flip Settings → Remote → Advanced → **Auto tunnel** and the PC installs cloudflared on demand (pinned release, SHA-256-verified), spawns a quick tunnel, and puts its URL in the QR by itself — the phone just scans; no marudesk cloud, nothing to install on either device (see [`mobile/README.md`](mobile/README.md)). Review the agent's **file diffs from the phone** (expandable per-edit cards, revert applied edits, proposed diffs above Approve/Deny) and get **local notifications** when a background agent finishes or an approval is waiting. The phone is a thin client; the model, tools, and workspace always stay on the PC.

## Repository layout

Maru is a three-package workspace.

| Path | Role |
|---|---|
| `marudesk/` | Electron desktop app — browser stage, DevTools, agent loop, editor/terminal, workspace integration, packaging. Owns the model/tool/workspace loop. |
| `mobile/` _(archived)_ | Capacitor thin client — removed from the active workspace; preserved on the `archive/mobile` branch and `archive/mobile-v0.8.0` tag. |
| `relay/` | Node/TypeScript relay and auth service — brokers same-account host/client WebSocket traffic for the cloud-relay path. |

Inside `marudesk/`:

- `electron/` — main process: `browser/*` (tabs, navigation, downloads, CDP runtime capture), `agent/*` (session loop, tools, MCP, context sources, provider auth), plus settings, secrets, and the remote server.
- `src/` — React renderer, organized into feature slices (`features/browser`, `devtools`, `editor`, `agent`, `settings`, `terminal`, and others).
- `shared/` — transport-safe typed contracts used across main, renderer, and tests.
- `e2e/` — Playwright end-to-end tests. `docs/` — design and architecture notes. `DESIGN.md` — design-system rules.

## Tech stack

- **Electron 42** (Chromium 148), **React 19**, **TypeScript** (strict project builds)
- **Vite 8** build, **Zustand** state, **Tailwind** design tokens
- **Monaco** editor, **xterm.js** + **node-pty** terminal
- **Vercel AI SDK** (`@ai-sdk/*`) for model integration, **Model Context Protocol SDK** for tools
- **Playwright** for Electron/runtime end-to-end tests

## Getting started

Prerequisites: Node.js 20 or newer and npm. There is no root package; install per package.

```bash
# Desktop app
cd marudesk
npm install
npm run dev        # starts the Vite renderer + Electron shell
```

Optional companion package:

```bash
cd relay  && npm install && npm start      # cloud relay (defaults to port 8788)
```

### Configure a provider

Open **Settings → AI Providers** and either paste an API key or sign in with a subscription (OAuth). Then choose a model from the command-palette model picker. To enable automatic failover, turn on **Settings → Agent → Model fallback** and rank your models.

### Build a desktop package

```bash
cd marudesk
npm run build            # type-check + bundle
npm run package:win      # or: npm run package:mac / npm run package:linux
```

### Cut a release (CI)

Releases are built and published by the **Release** GitHub Actions workflow
(`.github/workflows/release.yml`). Pushing a `v*` tag builds marudesk on native
runners — macOS arm64 **and** x64 cross-built on Apple Silicon (`macos-14`),
Windows x64 (`windows-latest`), and Linux x64 (`ubuntu-latest`) — and uploads
the installers (`dmg` for macOS, NSIS `exe` for Windows, `AppImage` + `deb` for
Linux) to the GitHub release that matches `marudesk/package.json` version:

```bash
# bump marudesk/package.json version first, commit, then:
git tag v0.2.0
git push origin v0.2.0
```

A manual `workflow_dispatch` run builds the same matrix without publishing, so
you can smoke-test packaging. To build/publish from your own machine instead,
use `npm run publish:win` / `publish:mac` / `publish:linux` (`GH_TOKEN`
required), or `npm run package:*` for a local-only build.

### Auto-update (Windows)

The Windows build auto-updates in place via `electron-updater`: on launch it
checks the GitHub Releases feed, downloads a newer NSIS package in the background,
and offers a "restart & install" action in **Settings → About** (it also installs
on the next quit). For this to work, each release must carry the update metadata
(`latest.yml` + the installer and its `.blockmap`), which the CI workflow (and
`npm run publish:win`) produce automatically.

The feed is configured by `build.publish` in `marudesk/package.json`
(`Liruns/marudesk`). macOS and Linux keep the manual check (it opens the
releases page): the Mac `dmg` is currently unsigned (download-and-run, requires
Apple code signing + notarization before auto-update can be enabled), and the
Linux `AppImage`/`deb` are download-and-run for now.

## Development and verification

Run the checks for the package you changed:

```bash
cd marudesk
npm run typecheck
npm run lint
npm run e2e              # Playwright end-to-end suite
```

Targeted main-process and server harnesses:

```bash
npm run harness:server        # remote server (loopback)
npm run harness:e2e           # server end-to-end
npm run harness:pair          # secure device pairing
npm run harness:relay-bridge  # cloud relay bridge
npm run harness:mcp           # MCP tools
npm run harness:plugins       # isolated plugin runtime (worker sandbox + tool RPC)
npm run harness:plugin-lifecycle  # plugin install / enable / remove lifecycle
npm run harness:orchestration # agent tree + approval queue projection
```

UI work follows `marudesk/DESIGN.md`: dark-first, restrained, token-based colors only (no hard-coded colors), Lucide icons, and calm, precise copy.

## Project status

Maru is a personal, in-development project used as a daily driver and portfolio piece. Expect rough edges.

- Subscription OAuth for **ChatGPT** and **Gemini** uses undocumented backends and is **experimental**; API-key access and Claude / xAI OAuth are the stable paths.
- Maru is not affiliated with any model provider. Using subscription logins in a third-party client may be subject to each provider's terms — use at your own discretion.
- Released under the [MIT License](LICENSE).

## Documentation

- `AGENTS.md` — workspace agent guide and command rules
- `marudesk/README.md` — desktop package details
- `marudesk/DESIGN.md` — design system
- `marudesk/docs/` — product roadmap and architecture / design notes
- `relay/README.md` — companion package

## License

[MIT](LICENSE) © 2026 Liruns
