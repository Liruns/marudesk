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
   - `mobile/` is archived (removed from the active tree; preserved on the
     `archive/mobile` branch). Do not recreate it here.
   - `reference/` holds read-only vendored snapshots (e.g. `reference/pane/`)
     for design/feature reference only — not built or shipped, and any nested
     `AGENTS.md` / `CLAUDE.md` there belongs to the upstream project, not
     marudesk. See `reference/README.md`.
4. Do not revert user edits or unrelated worktree changes.
5. Verify from the package that owns the behavior before claiming completion.

For concrete commands and conventions, see `AGENTS.md`.
