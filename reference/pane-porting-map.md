# pane → marudesk porting map

A capability-by-capability comparison between the vendored **pane** snapshot
(`reference/pane/`) and the live **marudesk** app (`marudesk/`), so we can pull
pane's design and ideas across deliberately instead of copying raw vanilla JS.

**Stacks differ on purpose.** pane is vanilla JS with no build step; marudesk is
strict TypeScript + React + Vite. Ports are *re-implementations* in marudesk's
idiom (tokens from `marudesk/src/styles/tokens.css`, no hard-coded colors), not
file copies.

Legend: **GAP** = pane has it, marudesk doesn't · **PARITY** = both have it ·
**MARUDESK AHEAD** = marudesk is more complete · **SPEC** = pane has it only as
a design doc.

---

## A. Design / look-and-feel

pane is dark, Apple-inspired, **one blue accent**, Inter. marudesk is
Linear-inspired, **violet accent**, but already ships a full theming system
(light/dark × palettes × accents) driven by `[data-palette]` / `[data-accent]`
attributes on `<html>`.

| Token | pane (`reference/pane/src/renderer/styles/tokens.css`) | marudesk (`marudesk/src/styles/tokens.css`) |
|---|---|---|
| Accent | `#0071e3` (blue), dark variant `#2997ff` | `#5E6AD2` (violet) + presets blue/teal/green/amber/rose |
| Page surface | `--canvas #0a0a0b` | `--surface-page #08090A` |
| Panel / card | `--surface #1d1d1f` / `--surface-1 #272729` | `--surface-1 #1A1B1F` … `--surface-3 #2D2F36` |
| Text | `#f5f5f7` + muted/faint alphas | `#F7F8F8` + secondary/tertiary/disabled |
| Font | Inter / JetBrains Mono | Inter / Inter Display / JetBrains Mono |
| Metrics | `--tabstrip-h 40px` `--toolbar-h 48px` | (per-component) |
| Motion | 150/300/500ms, three ease curves | 120/200ms, single easing |

**Best port:** marudesk's theme system already supports adding skins without
forking the design — so bring pane's look in as **a "Pane" palette + the blue
accent**, not a rewrite. Touch points:

- `marudesk/src/styles/tokens.css` — add a `:root[data-palette='pane']` block
  (Apple-dark surfaces above) and, if the existing `blue` accent isn't close
  enough, a `pane` accent at `#0071e3`.
- `marudesk/src/features/theme/store.ts`, `PaletteSwatches.tsx`,
  `AccentSwatches.tsx` — register the new palette/accent + preview swatch.
- Read `reference/pane/DESIGN.md` for the rationale (single accent, the page is
  the hero, opaque toolbar, 2px accent focus rings).

---

## B. `pane://` internal screens

pane serves real, addressable internal pages over a `pane://` protocol
(`reference/pane/src/main/protocol.js` + `reference/pane/src/internal/*`).
marudesk has **no internal-page protocol** — new tabs are `about:blank`, and the
equivalent surfaces are React UI, not in-browser pages.

| pane page | pane source | marudesk today | Verdict |
|---|---|---|---|
| new-tab / start | `src/internal/newtab/` | `about:blank` (`marudesk/electron/browser/tabs.ts` `NEW_TAB_URL`) | **GAP** — no real start page |
| error page | `src/internal/error/` | none | **GAP** |
| history | `src/internal/history/` | `BrowserLibraryPanel.tsx` drawer (History tab) | PARITY (drawer, not a page) |
| bookmarks | `src/internal/bookmarks/` | `BrowserLibraryPanel.tsx` drawer (Bookmarks tab) | PARITY (drawer) |
| downloads | `src/internal/downloads/` | `DownloadShelf.tsx` shelf | PARTIAL (shelf, no page) |
| settings | `src/internal/settings/` | `src/features/settings/SettingsView.tsx` | MARUDESK AHEAD |

**Best port:** a real **start page** and **custom error page**. Either render
them as React routes shown over the stage, or register a `maru://` (or
`about:home`) Electron protocol mirroring pane's pattern. Pointers:
`reference/pane/src/main/protocol.js`, `reference/pane/src/main/internal-ipc.js`
(origin-checked bridge) vs `marudesk/electron/browser/url.ts` (which today
refuses non-`http(s)` schemes) and `marudesk/electron/browser/tabs.ts`.

---

## C. Browser features

| Feature | pane | marudesk | Verdict |
|---|---|---|---|
| **Smart address bar** (scheme/`localhost`/IPv4/IPv6/IDN/Windows-path/PSL → load else search) | FULL — `src/renderer/features/url-parser.js`, `lib/host.js`, vendored `lib/vendor/tldts.js` + denylist | simple `http(s)`-prefix check (`marudesk/electron/browser/url.ts`); good suggestion ranking in `marudesk/shared/suggest.ts` | **GAP** — no public-suffix-list / smart parsing |
| Address suggestions / autocomplete | FULL | FULL (`AddressSuggestions.tsx`, `useAddressSuggestions.ts`) | PARITY |
| Tabs: drag-reorder, right-click menu, reopen-closed, `Ctrl+Tab` | FULL | FULL **+ tab groups + sessions** (`src/features/tabs/*`, `electron/browser/tab-*.ts`) | MARUDESK AHEAD (pane: double-click-to-maximize tab is a small extra) |
| Navigation + loading bar | FULL | FULL (`BrowserToolbar.tsx`, `electron/browser/navigation.ts`) | PARITY |
| In-page right-click context menu (open-in-bg-tab, copy/save, search selection, spellcheck, Inspect Element) | FULL — `src/main/page-context-menu.js` | FULL — `marudesk/electron/browser/context-menu.ts` | PARITY (compare item coverage) |
| Find-in-page · per-tab zoom · DevTools docking | FULL | FULL (`BrowserFindBar.tsx`, `electron/browser/zoom.ts`, `src/features/devtools/*`) | PARITY |
| Downloads (auto-save, progress, reveal) | FULL | FULL (`DownloadShelf.tsx`, `electron/browser/downloads.ts`) | PARITY |
| Session restore | FULL | FULL, two-tier (`electron/browser/tab-session.ts`, `pinned-session.ts`) | MARUDESK AHEAD |
| Frameless window + native controls | FULL | FULL (`electron/main.ts`, `src/views/Shell.tsx`) | PARITY |

**Best port:** the **smart address-bar URL parser**. It's the one clear
functional gap and it's self-contained pure logic with tests already written.
Re-implement `reference/pane/src/renderer/features/url-parser.js` +
`lib/host.js` (PSL via `tldts`, plus the package-name denylist like `socket.io`,
`node.js`) as a typed helper in `marudesk/shared/` and call it from
`marudesk/electron/browser/url.ts`. Port the cases in
`reference/pane/test/url-parser.test.mjs` into marudesk's test suite.

---

## D. Infinite-canvas direction

This is the interesting inversion:

- In **pane**, the canvas is the **future** — a design spec (`reference/pane/CANVAS.md`)
  plus pure layout/camera math with unit tests
  (`reference/pane/src/main/canvas/{arrange,camera,canvas-layout,easing,resize}.js`
  and `reference/pane/test/{arrange,camera,canvas-layout,easing,resize}.test.js`).
  The product canvas itself isn't built yet.
- In **marudesk**, the canvas is the **shipped core shell** — an infinite,
  pannable/zoomable plane of freeform cards
  (`marudesk/src/features/canvas/CanvasStage.tsx`, `store.ts`, `CanvasCard.tsx`,
  `CanvasEdges.tsx`, `CanvasSections.tsx`, `CanvasMinimap.tsx`,
  `CanvasPlanFlow.tsx`).

So marudesk leads on implementation; pane's value here is the **spec and the
math**. Mine `CANVAS.md` for interaction ideas marudesk's canvas may lack, and
borrow pane's tested **arrange / camera / easing** helpers if marudesk wants
auto-layout, fit-to-content camera moves, or smoother animated transitions —
re-implemented as typed helpers feeding the canvas `store.ts`.

---

## Suggested first ports (prioritized)

All four are now implemented in `marudesk/` (strict TS + tests, no raw-JS copy):

1. ✅ **"Pane" palette + "Pane Blue" accent** in the theme system (§A) —
   `src/styles/tokens.css` (`[data-palette='pane']` + `[data-accent='pane']`),
   registered in `shared/settings.ts`, `src/features/theme/store.ts`, the swatch
   grids, and `public/boot-theme.js`. Pick palette = Pane + accent = Pane Blue.
2. ✅ **Smart address-bar URL parser** (PSL via `tldts` + package denylist) (§C)
   — `electron/browser/url.ts` + `url.test.ts` (37 cases). Keeps marudesk's
   refusal of `file:`/`javascript:`/… and its https-for-the-web default.
3. ✅ **Start page + custom error page** (§B) — a `maru://` privileged scheme
   (`electron/browser/internal-pages.ts` + `internal-page-render.ts`,
   `shared/internal-pages.ts`); `maru://newtab` replaces `about:blank`, and a
   real main-frame `did-fail-load` shows `maru://error` (Retry / Search).
4. ✅ **Canvas math → eased camera glide + the full CANVAS.md §6 gesture set** (§D)
   — pane's easing + `fitPose` + `slotRect`/`packGrid` ported to
   `src/features/canvas/camera-math.ts` (+ tests). Everything pane's canvas
   shipped is now in marudesk's:
   - **Eased Fit / Reset** camera glide (`animateTo`, easeInOutCubic).
   - **Keyboard camera keymap** — `+`/`-`/`0`/`F`/arrows.
   - **Focus-a-card** tween — double-click a card header or "Zoom to card".
   - **Auto-arrange (Tidy)** — `packGrid` into an aligned grid, animated; control
     button + menu item.
   - **Pan-fling inertia** — friction-decay glide on a fast pan release.
   - **Card-fling spring** — `easeOutBack` overshoot settle on a fast card flick.
   - A quiet **empty-canvas hint**.
   All honor `prefers-reduced-motion`. (pane's `CANVAS.md` is a spec doc; nothing
   from §1–§5/§7 architecture applies — marudesk's canvas is already shipped.)
