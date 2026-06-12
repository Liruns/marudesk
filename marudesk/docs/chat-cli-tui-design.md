# Chat CLI v2 — a Claude-Code-style TUI + first-class desktop integration

Status: implementing
Builds on: the loopback chat client (`scripts/chat-cli.mjs`, commit `e669066`),
the bridge server (docs/remote-mobile-bridge-design.md §M4), T2 secure pairing
(docs/t2-secure-pairing-design.md), agentic chat v2–v4 docs.

## 1. Goal

Turn the line-based REPL shipped in `e669066` into a real terminal coding-agent
UI — the Claude Code / Codex CLI / pi / OpenCode interaction grammar — and make
it a first-class *surface* of the desktop app:

- **Standalone**: `npm run chat` (or the packaged binary path) works in any
  terminal with zero configuration while the app runs.
- **Embedded**: a terminal tab can host the CLI (`agent-cli` terminal profile).
- **Replacement**: `Settings → Agent → Chat surface` can flip the AI-Chat
  toggle (titlebar button, `askAgent()` deep links) from the React panel to the
  CLI terminal tab. The CLI must therefore be able to do everything a chat
  session needs: stream text + reasoning, render tool calls, answer questions,
  **approve gated tools**, pick models, start/resume sessions.

Non-goal: a second agent loop. The PC main process stays the single authority
(same thin-client philosophy as the mobile bridge); the CLI is a projection of
`agent:event` snapshots plus the same command verbs.

## 2. What blocks "replacement" today

| Gap | Today | Needed |
| --- | --- | --- |
| Connectivity | CLI only works while *Settings → Remote → Local server* is ON (it writes `cli-bridge.json`); that server binds `0.0.0.0` and is OFF by default | an always-available, loopback-only path |
| Approvals | L-1 guard pins gated-tool approvals to the desktop UI for **every** bridge peer | local CLI must approve gated tools (it *is* the desktop user) |
| Model choice | `--provider/--model` must be typed manually; no bridge route lists models | `/model` picker → needs a models route |
| Sessions | bridge has no session routes | `/sessions` + resume |
| UX | line REPL: no composer, no slash menu, no approval panels, no status | inline TUI (see §5) |

## 3. The companion listener (loopback bridge, always on)

`electron/server/companion.ts` — a second `http.Server` reusing the SAME pure
router (`handleRequest`) and the same bearer token (`getServerToken()`), with
deliberately different deps:

- binds `127.0.0.1` on an **ephemeral port** (`listen(0)`) — never another
  interface, so it is unreachable off-machine by construction;
- **no** `devices` / `pair` deps (no E2E path, `/pair` 404s);
- **no** `approvalGuard` — gated-tool approvals are allowed. Trust model: the
  bearer token lives only in `cli-bridge.json` (mode 0600, userData), so
  presenting it proves "same user, same machine" — the same boundary the
  Chrome `DevToolsActivePort` file draws. A process that can read userData can
  already read sessions/settings, so no new boundary is crossed. The L-1 guard
  exists for *remote* peers (LAN/Tailscale/relay) and stays untouched on the
  remote server.
- starts at app boot, stops at quit; always on, no setting (Chrome/VS Code
  precedent). A bind failure is logged and degrades gracefully (the CLI then
  reports "no bridge connection").

**`cli-bridge.json` ownership moves here.** The remote bridge server stops
writing it (two writers would clobber each other's lifecycle: stop of one
deletes the other's live handshake). `npm run chat` therefore works whenever
the app runs — Remote can stay OFF. Explicit `--url/--token` or
`MARUDESK_BRIDGE_URL/TOKEN` still override, so driving the remote server (or a
test harness) stays possible.

## 4. New bridge routes (read-mostly, both servers)

`RouterDeps` gains an optional `extras` dep (injected; mockable in harnesses);
the routes 404 when absent. They are NOT added to `RelayCommandName` — the
frozen Model-B relay protocol does not change.

- `GET /agent/models` → `{ providers: [{ id, label, connected, models: ModelDef[] }], current: ModelRef | null }`
  - built from the provider registry + `getModelsFor()` (5-min cache, static
    seed fallback); `connected` = stored credential present (or keyless).
    Models are fetched only for connected providers (others return their
    static seed) so the route stays fast.
  - `current` is the persisted last-used chat model so the CLI defaults match
    the desktop picker.
- `GET /agent/sessions` → `SessionSummary[]` (same shape as `agent:list-sessions`).
- `POST /agent/resume-session` `{ id }` → `{ ok }` (same as `agent:resume-session`;
  the next SSE snapshot carries the restored transcript).

## 5. The TUI (`marudesk/cli/`, zero dependencies, strict TS)

Inline rendering, not alt-screen (Claude Code / pi grammar): the transcript
streams into normal terminal scrollback; only a sticky bottom block is redrawn
in place. This survives embedding in the app's xterm tab and keeps native
scrollback/search usable.

```
cli/
  main.ts       arg parsing, connection resolve, mode select (TTY → TUI;
                --prompt or non-TTY → line mode), exit codes
  client.ts     typed REST + SSE client over the bridge (port of v1 logic)
  transcript.ts snapshot differ → append-only printed lines (pure)
  markdown.ts   markdown-lite → ANSI (headings/bold/italic/inline+fenced code,
                lists, blockquote) + width-aware wrap (pure)
  composer.ts   line-editor state machine: text/cursor/history/kill-line (pure)
  keys.ts       stdin byte decoder: keypresses, bracketed paste, ESC vs
                escape-sequences disambiguation (pure)
  slash.ts      CLI slash registry (reuses shared/slash-commands.ts prompt
                commands verbatim; local actions below) (pure)
  tui.ts        the interactive shell: raw mode, render loop, overlays
  line-mode.ts  the v1-style plain REPL + one-shot --prompt (non-TTY safe)
```

Pure modules carry the logic so the harness can test them without a TTY.

### Surface grammar

- **Transcript** (scrollback): user echo `│ >` block, streamed assistant
  markdown, reasoning streamed dim-italic under a `✦ thinking` rule, one line
  per tool call (`⚙ running… → ✓/✗ name — summary`, spinner while running),
  plan (Taskboard) rendered as a checklist when it changes, end-of-turn line
  (`✔ done · in/out tokens` or `✗ error`), compaction divider.
- **Sticky bottom block** (repainted): status line (state dot/spinner ·
  provider/model · context-window % · cumulative tokens · elapsed), a bordered
  composer (`╭─╮ > … ╰─╯`), and a hint line that swaps to the slash menu / a
  picker / an approval panel as needed.
- **Keys**: Enter send · Shift-likely terminals fall back to `\` + Enter for a
  literal newline (raw mode can't see Shift+Enter portably) · ↑/↓ history when
  empty, cursor moves otherwise · ←/→/Home/End/Ctrl+A/E/U/K/W edit · Tab or
  Enter accepts slash completion · **Esc aborts the running turn** · Ctrl+C
  clears input / double-press exits · Ctrl+D on empty exits · bracketed paste
  inserts verbatim (multi-line stays in the composer).
- **Approvals**: `pendingApproval` swaps the bottom block for a panel — tool
  name, detail, per-file diff stats for edit previews (`diffs`) — keys
  `y` approve / `n` deny. Works for gated tools via the companion (§3).
- **Questions**: `pendingQuestions` panel — options as a numbered list (digit
  or ↑/↓+Enter), free-text fallback.
- **Slash commands**: `/` opens the menu (filtered as you type; ↑/↓ select).
  - prompt commands come straight from `shared/slash-commands.ts`
    (`/init /review /test /explain /commit` — `expand(arg)` → send), so CLI
    and panel can't drift;
  - local actions: `/model` (provider→model picker over `GET /agent/models`,
    persisted to `cli-prefs.json`), `/new` (reset), `/sessions` (list +
    resume picker), `/resume <id>`, `/status` (connection/model/usage/approval
    mode), `/approval-mode <mode>`, `/help`, `/exit`.
  - desktop-only actions (`/diff /copy /compact`) are listed in `/help` as
    "desktop panel only" for now (compact has no loop API on the bridge yet).
- **Resize**: `stdout.on('resize')` re-wraps and repaints the bottom block.
- **First run**: if no model is remembered, the model picker opens
  automatically (replaces v1's "pass --provider/--model once" error).

### Line mode (kept)

`--prompt/-p` one-shot and non-TTY stdin/stdout keep the v1 behavior (send →
stream plain text → exit code), so pipes, scripts, and the existing harness
pattern keep working. TUI-only affordances degrade away cleanly.

## 6. Desktop integration

### 6.1 `agent-cli` terminal profile

- `shared/terminal.ts`: `TerminalCreateOptions.profile?: 'shell' | 'agent-cli'`
  (+ echoed on `TerminalCreated`). The renderer still never chooses a command —
  it names a profile; main decides what that means (same trust model as the
  shell override).
- `electron/terminal.ts`: for `agent-cli`, spawn the built CLI entry and
  inject `MARUDESK_BRIDGE_URL/TOKEN` (companion §3) into the child env *after*
  the `inheritedEnv()` secret-strip — deliberate, child-only, never reaches a
  user shell. The entry resolves NEXT TO main.mjs (`import.meta.url`), so dev,
  e2e, and packaged (`app.asar.unpacked`) all work (§7).
- **Which binary runs it** (found the hard way): `node` from PATH when present;
  else on mac/linux `process.execPath` with `ELECTRON_RUN_AS_NODE=1`; on
  Windows WITHOUT node, the Electron binary is wrapped in `cmd.exe /d /s /c` —
  electron.exe is a GUI-subsystem image, so spawned directly under ConPTY its
  std handles never attach (zero output, no TTY, even in RUN_AS_NODE mode);
  console-subsystem cmd makes the console real and the child inherits usable
  handles. The cmd line is passed as a string (node-pty's `\"` argv quoting is
  not cmd quoting).
- Tabs: `TabState.terminalProfile?: 'agent-cli'` rides main→renderer exactly
  like `pluginPanel`; `browser:tabs-new` accepts it; the terminal session
  passes it to `terminal:create`; tab title "AI Chat (CLI)".

### 6.2 Surfaces (panel + CLI, no routing setting)

- The `agent.chatSurface` setting is REMOVED: the chat drawer/panel and the
  "AI Chat (CLI)" terminal tab are both always available. Chat-open intents
  (titlebar toggle, console "Fix this" via `drawerOpenNonce`) always open the
  drawer; the CLI tab opens from the Home launcher card (`openCliChatTab()`)
  or the installed `marudesk` terminal command (electron/cli-command.ts).

## 7. Build & packaging

- The CLI builds as an extra electron-build entry → `dist-electron/chat-cli.mjs`
  (single self-contained file; only `node:` imports — shared/* code is inlined
  by the bundler, which is what lets it reuse `slash-commands.ts` while staying
  zero-dep at runtime).
- `package.json`: `asarUnpack` adds `dist-electron/chat-cli.mjs` so the
  packaged app has a real on-disk file for `ELECTRON_RUN_AS_NODE` to execute
  (plain-Node children can't read inside app.asar).
- `npm run chat` → runs the TS source directly via
  `--experimental-strip-types` (harness-register resolver), so dev needs no
  build step; the packaged/embedded path uses the built file.
- `scripts/chat-cli.mjs` (v1) is deleted; README updated.

## 8. Verification

- `harness:cli` (extended): keeps the v1 end-to-end cases (mock router → real
  CLI child in line mode), adds `GET /agent/models`/sessions route coverage and
  pure-module cases (composer editing, key decoding incl. bracketed paste,
  snapshot→transcript diffing, slash resolution, markdown wrap).
- companion: a headless harness around the companion lifecycle with injected
  paths/deps — asserts loopback-only bind, handshake write/remove, and that a
  gated approve is ALLOWED here while the guarded remote router still refuses
  it (the L-1 contrast case).
- e2e (Playwright): click the Home "AI Chat (CLI)" launcher → expect a
  terminal tab titled "AI Chat (CLI)" whose xterm shows the CLI banner (real
  PTY + real companion in the packaged-dev build).
- `typecheck`/`lint` 0, full `harness:all`, existing e2e suite stays green.

## 9. Out of scope (follow-ups)

- `/compact`, `/diff`, `/copy` on the bridge (need loop APIs / renderer state).
- Multi-thread switching from the CLI (Stage 12-B-2 threads).
- Image input from the CLI; media artifact *previews* render as path lines.
- A `marudesk` shell alias/binary shim for the packaged app (PATH install).
- Default-pinned approval hardening (L-1 follow-up) — unchanged by this work,
  the companion is explicitly *not* "remote".
