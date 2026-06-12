# Changelog

## Unreleased

### Remote / Mobile
- Manual pairing entry actually works: the desktop pairing card now has a
  "Copy pairing code" button that copies the full pairing payload (the short
  on-screen code alone could never pair), and the phone explains the fix when
  the short code is pasted. Pasted payloads survive copy line-wrapping.
- QR scanning works in shipped builds: the native ML Kit scanner plugin is now
  bundled with the Android app, with an in-app camera scanner (Shape Detection
  API) as the web/PWA fallback and paste entry as the final, clearly-announced
  fallback — the scan button no longer fails silently.
- Production mobile builds default to the real relay transport; the in-memory
  demo transport is now dev-only (opt-in via `VITE_USE_STUB`). A released app
  can no longer sign a user into a fake demo chat.
- Relay sessions refresh their access token before connecting instead of dying
  at token expiry and demanding a fresh sign-in.
- A revoked PC pairing now surfaces a clear "unpair and pair again" error on
  the phone instead of endlessly retrying with `HTTP 401`.
- The phone reloads the PC catalog (workspaces/models/sessions) after every
  reconnect or address failover, so the pickers can't be left empty.

## 0.8.0 - 2026-06-12

### Auth & Accounts
- Google sign-in via relay OAuth handoff, linked onto the active profile.
- Per-profile web partitions (cookies, storage, cache isolated per profile).
- Link / unlink Google account directly from the profile switcher.

### Providers & Usage
- Multi-provider OAuth expansion: device-code flow UI, credential rotation,
  multi-credential slot management.
- Usage dashboard: per-provider cost breakdown, session history, and
  provider setup guides.
- Self-hosted cross-network direct mode (no cloud relay needed).

### Remote
- Auto tunnel: spawn cloudflared on demand and feed its public URL into the
  pairing QR, enabling cross-network phone pairing without manual port
  forwarding.

### Agent
- Agent-loop step budget: configurable per-turn tool-call limit.
- Richer compaction trace: the `/compact` summary now preserves more
  structural detail for long conversations.
- Skill suggestions: the agent proposes relevant built-in skills when the
  task matches.

### Context
- Context-window usage ring in the StatusBar; clicking it opens the chat.
- Nudge to compact when the context window is almost full (manual mode only).

### Source Control
- Worktree lanes board (Mission Control): each lane now shows its GitHub PR
  (#number with open/draft/merged/closed state) and an aggregated CI verdict
  from the head commit's check runs, both clickable into an in-app browser
  tab, with a refresh button on the board.
- A lane's "open dev URL" now reuses the lane's one browser tab instead of
  opening a new tab on every click.

### Updates
- Manual "Check for updates" now uses the same electron-updater path as the
  startup auto-check on Windows, so the update is downloaded in-app with
  progress display and installed via "Restart to install" — no more opening
  the browser to the releases page.

### Fixes
- AI Chat tab isolation and tab restore reliability.
- Only show the compaction nudge in manual mode.
- Clear pre-existing typecheck errors on workspace open.

## 0.7.0 - 2026-06-12

### DevTools (parity expansion, #82)
- Sources/debugger panel with source maps, DOM-debugger breakpoints, and
  watch expressions; performance profiler and security panels; HAR export,
  coverage, syntax highlighting, and search polish; event listeners,
  accessibility, DOM editing, and layout overlays; IndexedDB/cache-storage
  inspection.

### Agent
- New runtime verification tools: `screenshot` (vision-capable models receive
  the live page as pixels — closes the edit → reload → "does it look right"
  loop), `get_web_vitals` (LCP/CLS/INP/TTFB with good/poor ratings),
  `arm_exception_capture`/`read_exception_capture` (pause-on-uncaught snapshot
  of call frames + local variables, auto-resume), and
  `triage_network_failure` (correlates a failed request with backend terminal
  scrollback across multi-root workspaces).
- Built-in skills shipped with the app: `save-regression-test` (turn a
  verified runtime fix into a Playwright regression test) and `write-plugin`
  (author a workspace plugin through the capability-gated runtime). User and
  project skills with the same name still take precedence.
- Estimated conversation cost (USD) next to the context gauge and in
  `/context`, derived from a bundled model pricing table; hidden for local or
  unknown models.
- Durable memory gains a clear-all action in Settings → Data.

### Terminal
- Build/test/runtime errors in integrated terminals are now detected from
  scrollback (secret-scrubbed, deduped), surfaced as an error badge on the
  terminal pane, and carry a one-click **Fix this** that hands the excerpt to
  the agent — the terminal twin of the console error loop.

### Editor
- TypeScript/JavaScript IntelliSense: completions, hover, signature help, and
  go-to-definition across open files via Monaco's TS language service.
- Format on save and inline current-line git blame, both behind new Editor
  settings toggles.
- Git diff gutter: added/modified/deleted line markers against HEAD.

### Browser
- Bookmarks: star toggle in the address bar and a toolbar panel
  (open/delete), persisted per profile.
- Address bar suggestions: bookmarks and frecency-ranked history with token
  highlighting, plus a search-the-web row.
- Tab groups: group tabs under a named, colored chip (collapse/expand,
  rename, recolor, ungroup, close group), with contiguous membership kept
  through drag-reorder and groups restored with the session.

### DevTools
- Network request details get proper tabs: Headers (collapsible,
  click-to-copy), Payload (query/form/JSON parsed), Response (raw/tree
  toggle, copy body), Timing (blocked/DNS/connect/TLS/send/wait/receive
  phase bars), and Initiator.
- WebSocket / SSE frames viewer: live frame log per connection (direction,
  opcode/event, payload preview with JSON tree, filter), with WS/SSE badges
  in the network table.
- Application panel storage editing: inline edit / add / delete for
  localStorage and sessionStorage, per-cookie delete.
- Elements gains a Computed tab with the classic box-model diagram
  (token-based colors) and a grouped, filterable computed-style list.

### Remote / mobile
- Review agent edits from the phone: per-edit unified diff cards in the
  mobile chat (expand, +N/−M stats, revert applied edits), and proposed
  diffs shown above Approve/Deny on write-tool approvals.
- Mobile local notifications for background-agent completion, new approval
  requests, and turn completion while the app is backgrounded, with a
  Notifications toggle in Account settings.

### Source control
- Stashes: list, apply, pop, and drop from a new Stashes section, plus a
  stash-changes action (optional message, includes untracked files).
- Merge conflict resolution: conflicted files get their own section with
  per-file accept ours/theirs/mark resolved/open actions, an operation
  banner (merge/rebase/cherry-pick), and Continue/Abort once everything is
  resolved. Conflict markers in open editor buffers are highlighted with
  accept current/incoming/both codelens actions.

### Security
- SSH host keys are now pinned on first sight and verified on every
  subsequent connect; a mismatch refuses the connection with an actionable
  error. Pinned keys are listed (and clearable) in Settings → Remote.

## 0.2.0 - 2026-06-08

- Add macOS desktop support: ship `dmg` builds for both Apple Silicon (arm64)
  and Intel (x64) Macs alongside the existing Windows installer.
- Add Linux desktop support: ship `AppImage` and `deb` builds (x64).
- Add a GitHub Actions release workflow that builds marudesk on native runners
  per platform/arch (macOS arm64, macOS x64, Windows x64, Linux x64) and
  publishes the installers to a GitHub release on every `v*` tag.
- In-app auto-update stays Windows-only for now; the macOS and Linux builds are
  download-and-run until macOS code signing/notarization lands.

## 0.0.1 - 2026-06-04

- Mark the first MaruDesk release baseline across the desktop app, mobile thin client, and relay service.
- Document the initial repository-level release entry.
