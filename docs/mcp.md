# MCP servers for this repo

This repository ships an `.mcp.json` at the root so that MCP-aware agents
(Claude Code, etc.) get a browser-automation tool when working in this project.
The server is **opt-in and lazy** — it only starts when an agent actually calls
one of its tools.

## What's configured

| Server | Package | Use it for | Status |
|---|---|---|---|
| `puppeteer` | `@modelcontextprotocol/server-puppeteer` | Driving a real Chromium against a URL (navigate / click / type / screenshot / evaluate). | ✅ Verified headless in cloud sessions |

The server is launched headless with `--no-sandbox` (required in the sandboxed
cloud container) via `PUPPETEER_LAUNCH_OPTIONS`.

> Note: the upstream `@modelcontextprotocol/server-puppeteer` package is in the
> archived MCP servers repo. It still works, and it downloads its own Chromium
> on first run.

## Important scope note

This server automates a **regular web browser** (Chromium) pointed at a URL. It
is great for testing marudesk's **web UI** (the Vite renderer served by
`npm run dev`, e.g. `http://localhost:5173`).

It does **not** drive the full **Electron desktop app**. The app's own e2e
(`marudesk/e2e`, `playwright.config.ts`) launches the *built* Electron binary
via Playwright's `_electron`, which needs a real/virtual display (xvfb on
Linux). The browser MCP server cannot substitute for that.

## Browsers in cloud sessions

The cloud container is ephemeral and starts without a browser installed.
Puppeteer downloads its own Chromium into `~/.cache/puppeteer` on first run, so
no manual install is normally needed. To pre-warm it once per fresh container:

```bash
npx -y puppeteer browsers install chrome
```

If you want this to happen automatically at the start of every web session, add
a `SessionStart` hook to `.claude/settings.json` that runs the install command.

## Verifying

A quick headless smoke check (from a dir where `puppeteer` is installed):

```js
import puppeteer from 'puppeteer';
const b = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const p = await b.newPage();
await p.goto('data:text/html,<h1 id=t>ok</h1>');
console.log(await p.$eval('#t', e => e.textContent)); // -> ok
await b.close();
```
