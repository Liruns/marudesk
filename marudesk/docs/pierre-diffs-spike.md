# Spike: @pierre/diffs for the diff viewer

Scoped, flag-gated spike replacing the in-house plain-text `DiffBlock` with
[`@pierre/diffs`](https://trees.software)'s `PatchDiff` in the git `DiffViewer`,
to add real syntax highlighting. **Default off** — `USE_PIERRE_DIFF = false` in
`src/features/git/DiffViewer.tsx`. Adopted with mitigations (see below).

## Why

`DiffBlock` renders unified-diff lines as monochrome plain text (no syntax
highlighting). `git:diff` already returns a standard `git diff` patch string
(with `diff --git`/`---`/`+++`/`@@` headers; untracked files get a synthesized
all-additions patch), which is exactly `PatchDiff`'s input — so the swap is a
direct feed:

```tsx
<PatchDiff
  patch={diff}
  options={{ theme: 'pierre-dark', preferredHighlighter: 'shiki-js' }}
  style={DIFF_CHROME_STYLE}
/>
```

The result is a split, syntax-highlighted diff with a file header, `-N +N`
stats, and add/remove bars (see `diff-preview/diff-spike.png`).

## The cost (measured) and the mitigations applied

`@pierre/diffs` (v1.2.7, Apache-2.0) depends on **Shiki** for highlighting, plus
`@shikijs/transformers`, `diff`, `@pierre/theme`. That is a much heavier
dependency than `@pierre/trees` (Preact-only):

| Measure | Value |
|---|---|
| Isolated preview `dist/assets` | ~11 MB across 306 chunks (all Shiki grammars + themes) |
| marudesk renderer `dist/assets`, flag **off** → **on** | 16 MB → 26 MB (**+10 MB**, mostly lazy grammar chunks) |
| Runtime for one TS diff (`shiki-js`) | ~4 chunks, **0 WASM chunks loaded** |

Mitigations baked into the spike:

- **`preferredHighlighter: 'shiki-js'`** — uses Shiki's pure-JS regex engine
  instead of the oniguruma **WASM** engine. Verified: rendering a TS diff loads
  **zero WASM chunks at runtime**, so **no CSP `wasm-unsafe-eval` is required**
  (the 622 KB wasm chunk still ships on disk but is never instantiated).
  Highlighting output is identical to the WASM engine.
- **Token chrome** — syntax colors come from the bundled `pierre-dark` theme;
  `DIFF_CHROME_STYLE` maps the `--diffs-*-override` surface (panel/gutter/line
  backgrounds, line numbers) onto marudesk tokens so the diff sits inside the
  app's surfaces (`--surface-1`, `--success-subtle`, `--error-subtle`, …).

Further reductions available but not applied here:

- **Limit languages** via `getSharedHighlighter({ langs: [...] })` /
  `preloadHighlighter` — controls which grammars load at runtime (the grammar
  chunks still ship as lazy files; this trims runtime loading, not asar size).
- **Worker pool** (`@pierre/diffs/worker`) to move highlighting off the main
  thread for large diffs.

Context: marudesk already ships monaco-editor (with its own much larger
tokenizer/workers) and highlight.js, so Shiki is a third highlighter. The +10 MB
is meaningful but not category-changing for this app; the WASM/CSP concern — the
real blocker — is removed by `shiki-js`.

## Verified in this environment

- Install `@pierre/diffs@1.2.7` (Apache-2.0) — resolves on the public registry.
- `tsc -b` clean with the spike wired (flag on), against the real types.
- `vite build` bundles cleanly (flag on); measured the +10 MB delta above.
- Isolated headless render (`diff-preview/`, `shiki-js` + token chrome) confirms
  the split highlighted diff and that no WASM loads at runtime.

**Not verified:** live behavior inside the Electron `DiffViewer` overlay (the
preview is an isolated render). A manual GUI pass with the flag on — over real
`git:diff` output, including untracked/binary/staged cases — is the next step
before adoption.

## How to run it

Flip `USE_PIERRE_DIFF = true` in `src/features/git/DiffViewer.tsx`, open a file's
diff from the Source Control panel.

## Recommendation

Strong visual upgrade with the WASM/CSP risk mitigated. The open decision is the
~10 MB asar growth vs. the value of highlighted diffs given monaco is already
present. If adopting, consider limiting `langs` to the workspace's common set and
enabling the worker pool for large diffs.
