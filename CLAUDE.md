# toy-prj Claude Instructions

@AGENTS.md

Claude-style agents should use this file as a pointer to the same project rules
that Codex-style agents use.

1. Read `AGENTS.md` first. It is the source of truth for workspace boundaries,
   RTK command usage, package commands, verification expectations, and
   documentation policy.
2. Treat this `CLAUDE.md` as a compatibility mirror, not a separate rule set.
   When project guidance changes, update `AGENTS.md` and then keep this file in
   sync.
3. Respect package ownership:
   - `marudesk/` owns the Electron desktop app and runtime-aware agent surface.
   - `mobile/` owns the Capacitor thin client.
   - `relay/` owns auth and same-account host/client brokering.
4. Do not revert user edits or unrelated worktree changes.
5. Verify from the package that owns the behavior before claiming completion.

For concrete commands and conventions, see `AGENTS.md`.
