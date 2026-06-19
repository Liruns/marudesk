# MCP servers for this repo

This repository ships an `.mcp.json` at the root so that MCP-aware agents
(Claude Code, etc.) get browser-automation tools when working in this project.
The servers are **opt-in and lazy** — they only start when an agent actually
calls one of their tools, so listing one you do not use costs nothing.

## What's configured

| Server | Package | Use it for | Status |
|---|---|---|---|
| `playwright` | `@playwright/mcp` | Driving a real Chromium against a URL (click/type/screenshot/read DOM). **Recommended.** | ✅ Verified headless in cloud sessions |
| `chrome-devtools` | `chrome-devtools-mcp` | DevTools-protocol debugging / performance tracing against a Chrome instance | ⚠️ Optional, needs a Chrome channel present |
| `puppeteer` | `@modelcontextprotocol/server-puppeteer` | Same browser-automation surface via Puppeteer | ⚠️ Optional; upstream package is archived and downloads its own Chromium |

`playwright` is the primary choice: marudesk already depends on Playwright for
e2e, and it is the one verified to run **headless** in the ephemeral cloud
container.

## Important scope note

These servers automate a **regular web browser** (Chromium) pointed at a URL.
They are great for testing marudesk's **web UI** (the Vite renderer served by
`npm run dev`, e.g. `http://localhost:5173`).

They do **not** drive the full **Electron desktop app**. The app's own e2e
(`marudesk/e2e`, `playwright.config.ts`) launches the *built* Electron binary
via Playwright's `_electron`, which needs a real/virtual display (xvfb on
Linux). The browser MCP servers cannot substitute for that.

## Browsers in cloud sessions

The cloud container is ephemeral and starts without a browser installed. The
Playwright browser path is provided via `PLAYWRIGHT_BROWSERS_PATH`
(`/opt/pw-browsers` in the managed environment). Install the headless browser
once per fresh container before using the `playwright` server:

```bash
npx -y playwright@latest install --with-deps chromium
```

On a local machine the same command works (it installs into the default
`~/.cache/ms-playwright`). If you want this to happen automatically at the start
of every web session, add a `SessionStart` hook to `.claude/settings.json` that
runs the install command.

## Verifying

A quick headless smoke check (from a dir where `playwright` is installed):

```js
import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const p = await b.newPage();
await p.goto('data:text/html,<h1 id=t>ok</h1>');
console.log(await p.textContent('#t')); // -> ok
await b.close();
```
