# reference/ — vendored read-only snapshots

This directory holds **read-only source snapshots of other projects** (ours),
kept purely as **design and feature reference** for marudesk. Browse them, port
ideas out of them — but do not treat them as part of marudesk.

## Not part of any build

The repository root has **no `package.json`**; every toolchain (Vite, `tsc`,
ESLint, Playwright) runs from inside `marudesk/`. Nothing under `reference/` is
compiled, type-checked, linted, bundled, or shipped. Adding or changing files
here cannot break `npm run typecheck` / `build` / `lint` / `e2e`.

## Rules

- **Do not edit a snapshot in place.** Edits would silently drift from upstream
  and the snapshot would stop being a faithful reference. To refresh, re-vendor
  from source (see each snapshot's provenance below) and replace the folder.
- **The nested `AGENTS.md` / `CLAUDE.md` / `.cursor/` / `.omd/` inside a snapshot
  are the *upstream* project's own agent rules — they are NOT marudesk's.**
  Ignore them when working on marudesk; the governing rules are the root
  `AGENTS.md` / `CLAUDE.md`.
- Port work lands in `marudesk/` in its own idiom (strict TS + React, tokens
  from `marudesk/src/styles/tokens.css`), not by copying raw JS across.

## Snapshots

### `pane/` — a small, beautiful browser ("the chrome is the product")

| | |
|---|---|
| Source | <https://github.com/Liruns/pane> |
| Commit | `e1894b5` (`e1894b55fe8e2cf3876a3ef3ece78a93f530ad06`) |
| Snapshot date | 2026-06-18 |
| License | MIT (code) · Inter font under OFL, see `pane/src/renderer/assets/fonts/LICENSE-Inter.txt` |
| Stack | Vanilla JS Electron, **no build step** (`electron .` runs `src/main/index.js`) |
| Size | ~7.2k lines across 114 files |

Pane is the focused single-window browser whose dark, Apple-inspired look the
project wants to learn from. Its design system lives in `pane/DESIGN.md`
(the long-form spec) and `pane/src/renderer/styles/tokens.css` (the
implementation); its infinite-canvas *future* is specced in `pane/CANVAS.md`.

**Run it standalone (optional, independent of marudesk's toolchain):**

```bash
cd reference/pane
npm install      # installs Electron 42 only
npm start        # launches pane
```

## Porting guide

See [`pane-porting-map.md`](pane-porting-map.md) for a capability-by-capability
map of pane → marudesk (design, `pane://` screens, browser features, and the
infinite-canvas direction), with file pointers and a prioritized list of the
first ports worth doing.
