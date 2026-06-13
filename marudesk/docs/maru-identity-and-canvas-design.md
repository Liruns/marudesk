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
- **Phase 2C — Promote canvas to default + rebrand. 🟡 rebrand done; default
  pending.** Done: **Maru** across the home hero/tagline, welcome/guide, window +
  splash titles, `build.productName`, package description, and the root README.
  *Pending:* making the canvas the DEFAULT surface — flipping the default route
  breaks the ~20 classic-shell e2e specs, so it needs a deliberate migration, and
  ideally full Shell integration (keeping the explorer/git/search rails + status
  bar around the canvas rather than the stripped `CanvasShell`).
- **Phase 2D — Spatial polish. 🟡 persistence done.** Canvas layout (placements +
  viewport) persists to `localStorage` (`maru.canvas.v1`). *Remaining:* zoom-to-fit
  (Fit button exists), minimap, card grouping/alignment, keyboard navigation,
  onboarding.

## 5. Open questions / deferred

- Relay + desktop remote bridge (`electron/server/*`) are kept (independent of
  mobile). They could later drive a web/canvas remote client — revisit in 2D.
- Whether splits survive *inside* a card (a card hosting its own mini-grid) or
  the canvas fully replaces splitting. Default: canvas replaces splitting; a card
  is one surface.
