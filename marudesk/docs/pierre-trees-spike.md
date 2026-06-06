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
| Theming | `unsafeCSS` + `--trees-*-override` vars | Design tokens map cleanly; custom props inherit through the shadow boundary |
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
   would be a `renderRowDecoration` / `unsafeCSS` add.
3. **Icons vs DESIGN.md §11.** Spike uses the built-in `set: 'standard'` with
   `colored: false` (monochrome, token-driven) to stay close to the design
   rules. Strict Lucide-only parity means injecting a Lucide `spriteSheet` and
   remapping slots/extensions — mechanical but real.
4. **Header buttons.** ExplorerPanel's new-file / new-folder / collapse-all /
   reindex buttons drive the in-house tree's store state. With the library
   owning expansion they need rewiring to model methods (`add` +
   `startRenaming`, per-directory `collapse()`). The spike covers create/rename
   via the right-click menu only.
5. **Beta API churn.** Pin the version; expect to revisit on upgrades.

## Recommendation

The bridge is real and the wins (virtualization, git status, drag/drop, Pierre's
polish) are concrete. Before committing to a full swap, the next step is a manual
GUI pass with the flag on to confirm shadow-DOM rendering, the inline rename
input, and context-menu placement feel right — then decide between full adoption
(resolving the five gaps above) and keeping the in-house tree with selective
visual borrowing.
