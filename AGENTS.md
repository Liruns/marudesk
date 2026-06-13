# toy-prj Agent Instructions

This file is the project-scoped operating guide for AI agents working in this
workspace. More specific instructions in subdirectories override this file.

## Workspace Map

- `marudesk/`: Electron + Vite desktop app. It owns the browser stage, DevTools
  panels, workspace file access, patch flow, agent chat, runtime evidence, the
  user plugin runtime (isolated-worker tools + slash commands), and desktop
  packaging.
- `relay/`: Node TypeScript relay and auth service. It brokers same-account
  host/client WebSocket traffic and exposes auth/OAuth endpoints.
- `mobile/` (archived): the Capacitor thin client has been removed from the
  active workspace. Its full source is preserved on the `archive/mobile` branch
  and the `archive/mobile-v0.8.0` tag. Do not recreate it here; restore from the
  archive ref (`git checkout archive/mobile -- mobile/`) if it is ever revived.

## Default Workflow

- Read the nearest `AGENTS.md`, this root file, and relevant package README
  before changing code.
- Prefer the smallest change that preserves existing package boundaries.
- Verify changes from the package that owns the behavior.
- Keep unrelated worktree changes intact. Do not revert user edits unless the
  user explicitly asks.
- Use `rg` for search and `rg --files` for file discovery.

## RTK Command Rule

When running shell commands in an agent session, prefix commands with `rtk`.

Examples:

```bash
rtk git status --short
rtk rg --files
rtk npm run typecheck
```

For PowerShell-native commands, wrap them through PowerShell while keeping the
outer `rtk` prefix:

```bash
rtk powershell -NoLogo -NoProfile -Command "Get-ChildItem -Force"
```

## Package Commands

Run commands from the package directory unless noted otherwise.

### marudesk

```bash
npm install
npm run dev
npm run typecheck
npm run build
npm run e2e
```

Use `npm run harness:*` scripts for targeted Electron/main-process coverage,
or `npm run harness:all` to run the whole headless-harness suite with one
summary (new harnesses go in `electron/harness-kit.ts` helpers and are
auto-discovered by the runner).

### relay

```bash
npm install
npm start
npm run typecheck
npm test
```

Keep relay payload forwarding account-scoped and payload-agnostic.

## Engineering Rules

- TypeScript stays strict. Avoid `any`, suppression comments, and broad casts.
- Prefer typed data boundaries and small pure helpers over ad hoc parsing.
- Keep `marudesk/shared/*` suitable for reuse across main, renderer, and tests.
- Do not introduce UI colors outside `marudesk/src/styles/tokens.css` and
  `marudesk/tailwind.config.ts`; follow `marudesk/DESIGN.md`.
- For frontend changes, run the relevant typecheck/build and manually exercise
  the real UI surface when practical.
- For relay auth or WebSocket changes, run the relay harness and include an
  HTTP/WebSocket-level verification path.

## Documentation

- Update the root `README.md` when package roles, setup, or verification flows
  change.
- Update package README files when package-specific commands or architecture
  change.
- Keep `CLAUDE.md` aligned with this file; it exists for Claude-style agents but
  should not fork the project rules.
