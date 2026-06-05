# Changelog

## 0.0.3 - 2026-06-05

Second feature release for the MaruDesk desktop app (`marudesk` 0.0.2 → 0.0.3),
covering pull requests #18–#39 merged after the 0.0.2 baseline.

### Added

- **User plugin runtime** — isolated `utilityProcess` JS plugins contributing
  agent tools, slash commands, host-mediated fs/net access, and sandboxed
  `plugin://` iframe UI panels. (#34)
- **SSH remote workspace roots** — read and edit files on remote hosts as
  first-class workspace roots. (#35)
- **Workspace deck lifecycle** — add, rename, reorder, and remove workspaces
  directly from the deck rail. (#18)
- **More API-key providers** — absorbed 5 additional OpenAI-compatible
  providers with an expansion plan. (#29)
- **Inline media in AI Chat** — render agent-generated images and videos inline
  in the chat transcript. (#21)
- **Paged file reads** — agent file-read tools are now line-addressable
  (paged) instead of a fixed 16 KB byte window. (#22)
- **Search upgrades** — glob filters, highlighted previews, and jump-to-line
  navigation. (#27)
- **Smarter `/compact`** — non-destructive history with auto-compaction and
  tail preservation. (#28)
- **Settings overhaul** — cross-category search, gear-menu launcher, Appearance
  fixes, and a Ctrl/Cmd+, shortcut. (#24, #26)
- **AI chat composer redesign** — refreshed composer, drawer/chrome polish, and
  AgentChat modularization. (#37)
- **Advanced agent prompting** — trust-boundary prompt-injection hardening,
  sticky keyword modes, `AGENTS.override.md`, `@`-import expansion, runtime
  context, approval-mode + global instructions, and a per-turn context hook. (#39)
- **Richer MCP results** — enriched external MCP tool-result content mapping. (#31)

### Fixed

- Stop duplicating workspaces on legacy re-list. (#20)
- Fix context-panel sizing, model-picker visibility, and the split tab-close
  crash. (#23)
- Media-generation fallback, session read-tracker reset, and patch symlink
  guard. (#25)
- Fix a category-aware Settings search regression and dedup the accent picker. (#26)
- Keep split-deck panes full height so selected tabs render. (#32)
- Preserve sibling workspace browser panes / fix pane repaint. (#38)
- Guard marudesk dev reload IPC `EPIPE` errors. (#36)
- Accept `pending` in the xAI video status enum. (#19)

### Docs

- Plugin runtime design (utilityProcess-isolated JS plugins). (#33)
- Multi-provider subagent (parallel agents) design. (#30)

## 0.0.1 - 2026-06-04

- Mark the first MaruDesk release baseline across the desktop app, mobile thin client, and relay service.
- Document the initial repository-level release entry.
</content>
</invoke>
