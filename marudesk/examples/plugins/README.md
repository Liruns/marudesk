# Writing a MaruDesk plugin

A plugin extends the agent with your own JavaScript: it can contribute **agent
tools** (functions the model can call) and **slash commands** (prompt templates).
Plugin code is **untrusted** — it runs in an isolated worker (an Electron
`utilityProcess` with the Node Permission Model plus a module sandbox), never in
the main process, and can only reach the filesystem, network, or a CLI through a
capability bridge the user approves per plugin.

The runnable reference is [`hello-world/`](./hello-world) (a greeting tool, a
workspace-file reader, a file writer, and a slash command).

## Anatomy

A plugin is a folder with two things:

```
my-plugin/
  manifest.json   # id, entry, declared permissions
  index.js        # CommonJS module exporting activate(ctx)
```

### `manifest.json`

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "What it does.",
  "main": "index.js",
  "engine": { "marudesk": "^1.0.0" },
  "permissions": ["tools", "commands", "fs:read"],
  "net": { "allow": ["api.example.com"] }
}
```

- `id` — `[a-z0-9-]`, **must equal the folder name**.
- `main` — entry module relative to the folder; it may not escape the folder.
- `engine.marudesk` — host-API compatibility range (display/compat only).
- `permissions` — the capabilities you declare; the user approves them (see below).
- `net.allow` — hostnames `ctx.http.fetch` may reach; only meaningful with `net`.

### `index.js`

```js
/** @type {import('marudesk/shared/plugin').PluginModule} */
module.exports = {
  activate(ctx) {
    ctx.registerTool({
      name: 'greet',
      description: 'Return a friendly greeting for the given name.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Who to greet' } },
        required: ['name'],
      },
      async handler(input) {
        const name = input && typeof input.name === 'string' ? input.name : 'world';
        return `Hello, ${name}!`;
      },
    });
  },
};
```

`activate(ctx)` runs **once** at load — register everything there. Tool handlers
run later, on demand, each inside the agent's approval flow. The optional
`onSessionStart` / `onSessionEnd` exports let a stateful plugin reset
per-conversation state without being torn down.

## The `ctx` surface

`ctx` is the only outside access plugin code gets. Members behind a permission
throw if that grant is absent; the `fs` / `http` / `exec` / `setStatus` members
are additionally only callable **from inside a running tool handler** (they need
the originating call's workspace).

| Member | Permission | What it does |
|---|---|---|
| `ctx.registerTool({ name, description, inputSchema, handler })` | `tools` | Register an agent tool. Activate-time only. `handler(input)` receives the model's JSON args as `unknown` (validate it yourself) and returns a `string` or `{ text }`. |
| `ctx.registerSlashCommand({ name, description?, argHint?, template })` | `commands` | Register a slash command. `template` is a prompt string; the renderer substitutes `$ARGUMENTS` with the trailing text. Activate-time only. |
| `ctx.fs.read(relPath)` → `Promise<string>` | `fs:read` | Read a workspace-relative text file as UTF-8 (capped). |
| `ctx.fs.list(relPath)` → `Promise<string[]>` | `fs:read` | List a workspace-relative directory; directory entries end with `/`. |
| `ctx.fs.write(relPath, data)` → `Promise<void>` | `fs:write` | Write/overwrite a workspace-relative text file through the agent's atomic patch apply, so the change shows in the chat diff/revert history (an identical write is a no-op). Respects the agent's never-edit globs. |
| `ctx.http.fetch(url)` → `Promise<{ status, text }>` | `net` | Host-mediated outbound **GET**. http(s) only, host must be in `net.allow`, SSRF/DNS-rebinding guarded, redirects are **not** followed, body capped. |
| `ctx.exec(command, { timeoutMs? })` → `Promise<{ exitCode, output, timedOut }>` | `cmd` | Run a workspace CLI through the host (same guarded spawn as the built-in run_command: workspace cwd, secret-shaped env stripped, output bounded). `timeoutMs` is clamped to 1s–600s (default 120s). |
| `ctx.setStatus(key, text)` | — | Push a keyed progress line (display only; empty `text` clears it). Handler-scoped. |
| `ctx.log(...args)` | — | Append a line to the plugin's in-app debug log. |

For editor autocomplete and typecheck, annotate your module with the hand-written
author types in [`marudesk/shared/plugin.ts`](../../shared/plugin.ts) — the
`PluginModule` / `PluginContext` / `PluginTool` / `PluginSlashCommand` exports.
They are derived from the same transport contracts the host enforces, so they
won't drift from what actually runs.

## Permission model

You declare `permissions` in the manifest; the user approves them in **Settings →
Plugins** before the plugin activates. A grant unlocks exactly one slice of `ctx`:

| Permission | Grants |
|---|---|
| `tools` | `ctx.registerTool` — contribute agent tools. |
| `commands` | `ctx.registerSlashCommand` — contribute slash commands. |
| `fs:read` | `ctx.fs.read` / `ctx.fs.list` — read inside the open workspace only. |
| `fs:write` | `ctx.fs.write` — write inside the open workspace, via the diffed patch apply. |
| `net` | `ctx.http.fetch` — GET only, to hosts you allowlist in `manifest.net.allow`. |
| `cmd` | `ctx.exec` — run a CLI in the workspace through the host's guarded spawn. |
| `ui` | A sandboxed UI panel (declared via `manifest.panel`). |

The grant is checked **twice** — once in the worker before the bridge call, and
again in the host before it touches anything — so the worker can't forge access it
wasn't given. There is no raw `require('fs')` / `require('https')` /
`require('child_process')`: those modules are denied in the sandbox; the only
sanctioned access is through `ctx`. Filesystem access is confined to the open
workspace root (escapes and symlinks out are rejected), and **changing the
manifest's permissions requires re-approval**.

## Installing

Plugins are discovered from two folders:

- **User scope:** `<userData>/plugins/<id>/`
- **Project scope:** `<workspace>/.marudesk/plugins/<id>/` (a project plugin with
  the same id shadows the user one)

To install a user plugin, open **Settings → Plugins** and use **Install from
folder** — pick your plugin folder and it is copied into the user plugins
directory and rescanned, appearing in the list. (You can also open the user
plugins folder from the same panel, drop a folder in, and reload.) Then enable the
plugin and approve its requested permissions; its tools and slash commands become
available to the agent.
