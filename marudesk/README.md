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

- Electron 33
- React 19 + Vite 8
- TypeScript 6 in strict project builds
- Tailwind tokens backed by `src/styles/tokens.css`
- Playwright for Electron/runtime end-to-end coverage
- Provider integrations through the AI SDK and provider-specific adapters

## Run locally

```bash
npm install
npm run dev
```

`npm run dev` starts the Vite renderer and Electron shell for local desktop
development.

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
```

## Architecture notes

- `electron/browser/*` owns browser tabs, navigation, downloads, DevTools wiring,
  and CDP-facing runtime capture.
- `electron/agent/*` owns agent session orchestration, MCP tool plumbing, context
  sources, and model loop behavior.
- `shared/*` contains transport-safe contracts used across Electron, renderer,
  tests, and companion surfaces.
- `src/features/*` contains renderer feature slices for browser, DevTools,
  editor, workspace, patch review, settings, git, terminal, and agent chat.

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
