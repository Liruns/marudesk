# Changelog

## Unreleased

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

### Remote / mobile
- Review agent edits from the phone: per-edit unified diff cards in the
  mobile chat (expand, +N/−M stats, revert applied edits), and proposed
  diffs shown above Approve/Deny on write-tool approvals.
- Mobile local notifications for background-agent completion, new approval
  requests, and turn completion while the app is backgrounded, with a
  Notifications toggle in Account settings.

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
