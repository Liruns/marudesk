# Spike: @pierre/trees for the workspace file tree

Scoped spike to evaluate replacing the in-house `FileTree`
(`src/features/workspace/FileTree.tsx`) with
[`@pierre/trees`](https://github.com/pierrecomputer/pierre) from Pierre Computer.

**Verdict: feasible, with bounded custom-bridge work.** Nothing here is a
blocker; the open questions are integration cost (expansion preservation,
clipboard dimming, icon parity), not viability.

## How to run it

`src/features/workspace/ExplorerPanel.tsx` has a module-level flag:

```ts
const USE_PIERRE_TREE = false; // flip to true to render the spike tree
```

Flipped on, the Explorer body renders `FileTreePierreSpike` instead of the
in-house tree. Default stays `false`, so shipped behavior is unchanged.

## What was verified in this environment

- `npm install @pierre/trees@1.0.0-beta.4` — resolves on the public registry.
- `tsc -b` — clean, with the spike fully type-checked against the real
  `@pierre/trees` `.d.ts` (the component lives in `src`, so it is always
  checked regardless of the flag).
- `vite build` with the flag **on** — bundles cleanly; renderer chunk grows
  ~1.85 MB → ~2.10 MB (≈+250 KB raw; Preact + the tree runtime). Pierre symbols
  (`file-tree-container`, `--trees-bg-override`) are present in the output.
- Library internals read from `node_modules/@pierre/trees/dist` to confirm the
  React path attaches its own shadow root (`host.attachShadow`) and needs no
  `web-components` side-effect import.

**Not verified:** live GUI behavior (shadow-DOM render, inline rename input,
context-menu slot positioning). The remote container has no Electron display,
so runtime interaction is the next manual step before any decision to adopt.

## Facts about the library

- **License:** Apache-2.0 (`@pierre/trees` and its `@pierre/path-store` dep).
- **Deps:** Preact + `preact-render-to-string` + `@pierre/path-store`. React is
  a peer dep only. **No shiki, no lit, no `@pierre/icons`** — much lighter than
  `@pierre/diffs`.
- **Maturity:** `1.0.0-beta.4` (pre-1.0; API may move).
- **Render model:** a `file-tree-container` custom element with its own shadow
  root; content is virtualized.
- **React API:** `useFileTree(options)` → `{ model }`, then
  `<FileTree model renderContextMenu header style />`. The hook builds the model
  **once** (`useState(() => new FileTree(options))`), so live updates go through
  imperative model methods, not prop changes.

## What bridges cleanly

| marudesk need | Pierre mechanism | Notes |
|---|---|---|
| Data from flat file list | `paths: string[]` + `model.resetPaths()` | Reconcile on reindex |
| Open file on click | `onSelectionChange` | No separate "activate" event, but marudesk single-click-opens, so 1:1 |
| Inline rename | `renaming: { onRename }` + `startRenaming()` | Built-in inline editor → `workspace:rename` |
| Inline create | `model.add()` + `startRenaming(p, { removeIfCanceled: true })` | The `removeIfCanceled` flag is purpose-built for new-item flows |
| Context menu | `renderContextMenu(item, ctx)` | Returns a React node **slotted in light DOM**, so marudesk Tailwind/token classes apply directly; `ctx.close()` dismisses |
| Theming | host `style` + `--trees-*-override` vars | Design tokens map cleanly; set on the host style (docs' first-class surface), custom props inherit through the shadow boundary |
| Virtualization | built-in | marudesk currently renders all flattened rows — net win on large repos |
| Git status | `gitStatus: GitStatusEntry[]` + override colors | marudesk has the data; not wired in the spike |
| a11y | library emits `level`/`posInSet`/`setSize` | Maps to tree ARIA internally |

## What needs custom work (documented gaps in the spike)

1. **Expansion preservation across `resetPaths`.** Every reindex pushes a new
   `paths` array → `resetPaths`, which can reset expansion. The model owns
   expansion (we'd drop the store's `expandedDirs` for the tree), and there is
   no public "enumerate expanded paths" accessor, so preserving open folders
   across a refresh needs care (`FileTreeResetOptions.initialExpandedPaths` +
   our own tracking, or a `subscribe` snapshot).
2. **Cut/copy/paste dimming.** No built-in clipboard. Menu actions wire to the
   existing store clipboard + `pasteInto`, but the "cut" 50%-opacity affordance
   would be a `renderRowDecoration` add.
3. **Icons vs DESIGN.md §11.** Spike now uses Pierre's built-in colored
   file-type set (`set: 'complete', colored: true`) — the per-type chromatic
   glyphs are the design upgrade we want, and they intentionally override the
   §11 "Lucide-only / currentColor" rule for this surface. If we later want
   Lucide geometry with this richness, the library accepts a custom
   `spriteSheet` + slot/extension remap, but that is optional, not required.
4. **Header buttons.** ExplorerPanel's new-file / new-folder / collapse-all /
   reindex buttons drive the in-house tree's store state. With the library
   owning expansion they need rewiring to model methods (`add` +
   `startRenaming`, per-directory `collapse()`). The spike covers create/rename
   via the right-click menu only.
5. **Beta API churn.** Pin the version; expect to revisit on upgrades.

## Conformance review against the official docs (trees.software)

Read the full trees docs (sourced from `apps/docs/app/(trees)/docs/**` in the
pierre monorepo, since the site blocks fetchers) and checked the spike against
them. The core wiring matches the documented patterns:

- `useFileTree(options)` creates the model once; live changes go through model
  methods (`resetPaths`, `setGitStatus`, …) — **matches** the docs' explicit
  "options are not a controlled update path" guidance.
- `<FileTree model renderContextMenu style />` with forwarded host props —
  matches the React API reference.
- `renaming: { onRename }` path-first events, `renderContextMenu(item, ctx)`
  React composition, `icons: { set: 'complete', colored: true }`,
  `onSelectionChange` — all documented options used correctly.

Corrections made after the review:

- **Theming moved off `unsafeCSS` onto the host `style` prop.** The docs name
  `--trees-*-override` the first-class styling surface (fallback layer 1) set via
  host `className`/`style`, and call `unsafeCSS` "the secondary path… keep it
  narrow… not a raw stylesheet-asset strategy." The spike originally injected all
  override vars through `unsafeCSS`; that abused the escape hatch. Now the vars
  are an inline `style` object on `<FileTree>` (and `host.style.setProperty` in
  the preview). Render output is identical.

Remaining doc-driven notes (not bugs, but "do it properly at scale"):

- **Input shape.** The spike feeds raw `paths` + `resetPaths` on every reindex.
  The docs call raw `paths` the path "for demos, tests, and very small static
  trees," and recommend `prepareFileTreeInput(...)` /
  `preparePresortedFileTreeInput(...)` produced off the UI boundary for real
  trees. marudesk's main process already builds and sorts the file list, so it
  is the natural place to emit **presorted prepared input** — the highest-perf
  path. This is the right production follow-up.
- **`flattenEmptyDirectories`.** The compact `a/b` rows in the screenshot are the
  library flattening single-child chains (on by default). The in-house tree does
  not compact; set `flattenEmptyDirectories: false` if we want parity.
- **`canRename` / `onError`.** The docs recommend `canRename` to protect files
  like `package.json` and `onError` to surface invalid renames. The spike wires
  only `onRename`; add the guards before adoption.
- **Density.** Prefer the `density` keyword (`'compact' | 'default' | 'relaxed'`)
  or `itemHeight` over hand-setting font size, to match the in-house 28px rows.
- **No "open/activate" event.** Confirmed: the model exposes selection and focus,
  not a file-open event. Opening on `onSelectionChange` is a marudesk product
  decision (single-click-opens), with the known caveat that re-selecting an
  already-selected path won't re-fire.

## Recommendation

The bridge is real and the wins (virtualization, git status, drag/drop, Pierre's
polish) are concrete, and the implementation now follows the documented styling
surface. Before committing to a full swap, the next step is a manual GUI pass
with the flag on to confirm shadow-DOM rendering, the inline rename input, and
context-menu placement feel right — then decide between full adoption (resolving
the gaps above, and moving to presorted prepared input) and keeping the in-house
tree with selective visual borrowing.
