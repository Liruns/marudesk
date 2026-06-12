# Changelog

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
