# Maru — identity & infinite-canvas design

> Status: in progress (2026-06-13). This is the blueprint for the identity
> overhaul that renames the product to **Maru** and replaces the tab-strip +
> split-grid shell with an **infinite canvas**. Repo, app id
> (`com.marudesk.app`), and codename stay `marudesk` to limit churn.

## 1. Identity

**Maru — an infinite canvas where AI sees your *running* app.**

The browser, code editor, terminal, and AI agent stop being tabs in a strip and
become **freeform cards** on a pannable / zoomable canvas. The differentiator is
unchanged and stays the hero: the agent reads the **live DOM, console, and
network (CDP)** of the app you are running and acts on that runtime evidence.
cate is a general infinite-canvas IDE; Maru is the *runtime-aware* one — a real
embedded browser is a first-class card, not a preview.

Positioning vs. the old identity:

| | Old (MaruDesk) | New (Maru) |
|---|---|---|
| Shell | Tab strip + split-pane grid | Infinite canvas of cards |
| Metaphor | An IDE with a browser tab | A spatial workspace you arrange |
| Hero | "AI sees your running app" | unchanged — still the moat |
| Mobile | Capacitor thin client | archived (`archive/mobile`) |

### Design principles (extends `DESIGN.md`)

- Dark-first, restrained, token-only colors (no change to the token discipline).
- The canvas is the surface; chrome recedes. Cards have minimal headers.
- Spatial memory over navigation: things stay where you put them, per workspace.
- Motion communicates space (pan/zoom inertia, zoom-to-fit), never decoration.

## 2. Relationship to cate (licensing)

cate (`github.com/0-AI-UG/cate`) is MIT-licensed and was the inspiration for the
infinite-canvas direction. We take the **concept**, not the code: Maru's canvas
is a clean-room implementation built on Maru's own primitives (the tab registry,
the existing surfaces, the `WebContentsView` bounds pipeline). No cate source is
copied or vendored. If any cate code is ever referenced directly, it must carry
MIT attribution — but the intent is independent implementation.

## 3. Architecture — reuse map

The canvas is built by **reusing** the cleanly-factored tab system, not replacing
it. What is reused vs. new:

| Concern | File | Canvas plan |
|---|---|---|
| Card *content* (what a kind renders) | `src/features/tabs/registry.tsx` (`tabKinds`) | **Reused as-is.** A card renders `tabKinds[tab.kind].render(tab.id, tab)`. |
| Tab/card identity & lifecycle | `src/features/tabs/store.ts` (`useTabsStore`) | **Reused.** A canvas node references a `tabId`; the tab still owns kind/title/url/workspaceId. |
| Surfaces (editor/terminal/agent/home/settings/plugin) | `src/features/{editor,terminal,agent,home,settings,plugins}` | **Reused unchanged.** |
| Web card positioning | `src/features/tabs/browserPaneBounds.ts` + `electron/browser/layout.ts` | **Reused.** `setBrowserPaneBoundsSource('canvas:<ws>', panes)`; empty panes ⇒ grid mode hides all web views (React canvas shows through). |
| Binary split math | `src/features/tabs/layout.ts`, `grid.ts` | **Not reused for placement.** Splits are a binary tree; the canvas needs free x/y/w/h. Kept intact for the legacy shell during rollout. |
| New: free-form placement + viewport | `src/features/canvas/store.ts` (`useCanvasStore`) | **New.** Nodes `{ id, tabId, x, y, w, h, z }` in canvas space + viewport `{ panX, panY, scale }`, persisted per workspace. |
| New: canvas surface | `src/features/canvas/CanvasStage.tsx` | **New.** Transformed plane hosting card frames; pan/zoom/drag/resize; measures web cards. |

### The web-card-under-transform technique (the one hard part)

Web cards are native `WebContentsView`s composited over the renderer, not DOM.
The canvas plane uses `transform: translate(panX,panY) scale(scale)`. Two facts
make this tractable:

1. `element.getBoundingClientRect()` returns the **post-transform** on-screen
   rect. So a web card's measured rect already reflects pan **and** zoom for
   *position and size* — no math needed; reporting it via the existing
   `setBrowserPaneBoundsSource` positions the view correctly. (`applyPaneBounds`
   in `electron/browser/layout.ts` rounds and clamps it.)
2. The page's **internal** scale is separate. At `scale < 1` the view frame is
   smaller but the page still renders at 100% (cropped). To make content scale
   with the canvas, set the view's zoom factor to `scale` (via `browser/zoom.ts`)
   whenever a web card is on the canvas. *(Phase 2B.)*

Rollout safety: an empty pane-bounds set already means "hide all web views," so
mounting the canvas with only feature cards is safe today.

## 4. Phased rollout

- **Phase 1 — Drop mobile. ✅ done.** Archived to `archive/mobile` branch +
  `archive/mobile-v0.8.0` tag; removed from the tree; CI android jobs and docs
  updated; desktop typecheck + doc checks pass.
- **Phase 2A — Canvas surface (feature cards). ✅ done.** `useCanvasStore` +
  `CanvasStage`/`CanvasCard`/`CanvasShell` behind the `#/canvas` route (app stays
  fully working), reachable from the activity bar. Pan/zoom/drag/resize, card
  chrome, renders editor/terminal/agent/home/settings via the registry. e2e:
  `e2e/canvas.spec.ts`.
- **Phase 2B — Web cards on the canvas. ✅ v1 done (positioning + omnibox).**
  Web cards report their post-transform rect through the shared `set-pane-bounds`
  pipeline, so the live `WebContentsView` tracks the card; a per-card address bar
  navigates the card's tab. *Deferred:* per-view zoom-factor = canvas scale (page
  content is 1:1 now, cropped when zoomed out) and web-card corner-resize. NB: the
  native view isn't in the page DOM, so this needs manual visual verification.
- **Phase 2C — Promote canvas to default + rebrand. ✅ done.** Rebrand: **Maru**
  across the home hero/tagline, welcome/guide, window + splash titles,
  `build.productName`, package description, tray, OAuth pages, agent identity
  prompts, settings, and docs; phone-app copy reframed as a desktop/LAN bridge.
  Default surface: the canvas is now a **Shell view-mode** (default) — it swaps
  only the stage centre, keeping the activity bar, explorer/search/git rails,
  context drawer, and status bar; the activity-bar Frame button toggles
  canvas ⇄ classic (persisted in `useSurfaceStore`). The standalone `#/canvas`
  route + `CanvasShell` were removed. Tests seed `maru.surface=classic` so the
  classic-shell e2e specs are unaffected.
- **Phase 2D — Spatial polish + node connections. 🟡 in progress.** Done: layout
  persistence (`localStorage maru.canvas.v1`), zoom-to-fit (Fit), workspace
  scoping, "New card", **web-card resize** + **multi-handle resize** (right/bottom/
  corner; handle + port sit on the card frame outside the native view and fade in
  on hover/focus), a **minimap** (cate parity, ⌘/Ctrl+Shift+M, click-to-recenter),
  **node connections** (a Maru addition beyond cate — drag a card's port to another
  card; bezier SVG edges, click-select, ×/Delete, persisted + pruned; drop target
  found by canvas geometry so it works over native web views), **right-click
  context menus** (empty canvas / card header / edge; bodies keep their own menus),
  **Figma-style wheel** (⌘/Ctrl = zoom-at-cursor + pinch, Shift = horizontal pan,
  plain = two-axis), double-click-to-create, and card-chrome polish (hover lift,
  focus ring, `:active` settle, hover-revealed controls). z is rebalanced to 1..N
  so layering never grows unbounded. **Responsive panels:** every surface
  (editor, settings, home, terminal, AI chat) + the card chrome now reflows for
  small cards (240–320px) using the codebase's container-query idiom — `@container`
  on each surface root + the compact value in the base class, full-size gated
  behind `@[…rem]:` min-width variants — so panes/splits are byte-identical and
  only small cards collapse (md split→stack, settings sidebar→top strip, grids→1
  col, chrome labels/buttons hide, menus/popovers cap to card width). **Also done:**
  **web-card content zoom-scaling** (the canvas sends its `scale` with the pane
  bounds; main `setZoomFactor`s each canvas web view so the live page scales with
  the canvas — classic grid omits `scale`, untouched), **keyboard navigation**
  (focusable card frame, arrow-nudge, Delete-close), **alignment snap** (drag snaps
  a card's edges to nearby cards within 6px), and an **in-canvas workspace
  switcher**. *Remaining:* card multi-select / grouping, keyboard selection of
  edges, and alignment guide lines.
- **Phase 2E — Multiple named canvases (= saved layouts). ✅ done.** A workspace
  owns an ordered set of named canvases and one is *open* at a time; in the
  **unified model** a canvas IS its saved layout, so switching loads a different
  one (no separate "apply a template"). The open canvas's spatial state is the
  store's hoisted working copy; the rest live in `byWorkspace`, synced at
  switch/persist/prune points. A **canvas switcher** in the toolbar
  (create/switch/rename/delete) sits beside the workspace switcher; new tabs land
  on the open canvas; deleting a canvas closes its panels (orphans would
  otherwise be re-adopted). Membership is implicit — a tab belongs to whichever
  canvas of its workspace holds its placement — so `CanvasStage`'s existing
  "render only placed tabs" rule gives per-canvas filtering + web-view hiding for
  free. **Restart-durable persistence:** because tab ids are random UUIDs minted
  fresh each launch (`electron/browser/tabs.ts`), canvases persist as **descriptor
  snapshots** (panels by kind + url/file/profile, groups as multi-member nodes,
  edges as `(node,member)` index refs) under `maru.canvas.v2`; on launch they
  reconcile to the tabs the main session restores by matching descriptors in
  order. Migrates `maru.canvas.v1` positions via a one-time by-tab-id pool.
  e2e: `e2e/canvas.spec.ts` (switch/delete + full-restart persistence).
  *Deferred:* "duplicate canvas" (branch the open arrangement into a new one) —
  the unified model doesn't require it, but it's a natural follow-up.

## 5. Open questions / deferred

- Relay + desktop remote bridge (`electron/server/*`) are kept (independent of
  mobile). They could later drive a web/canvas remote client — revisit in 2D.
- Whether splits survive *inside* a card (a card hosting its own mini-grid) or
  the canvas fully replaces splitting. Default: canvas replaces splitting; a card
  is one surface.
