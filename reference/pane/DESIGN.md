---
omd: "0.1"
brand: Pane
bootstrapped_from: apple
bootstrapped_at: "2026-06-16"
revised: "2026-06-16"   # v2 — applied independent design + technical review (see trailing comment)
id: pane
name: Pane
category: developer-tools
primary_color: "#0071e3"
mode: dark-default
influences:
  apple-hig: "Clarity / Deference / Depth, optical SF typography, single accent, Liquid Glass translucency — base reference."
  arc-zen: "Calm dark browser chrome; UI that hides until needed."
tokens:
  source: "bootstrapped-from-apple — dark-default variation for app chrome"
  colors:
    primary: "#0071e3"            # Apple Blue — the ONLY chromatic accent (fills, focus rings)
    accent-on-dark: "#2997ff"     # Brighter blue for links / text-level accent on dark (Apple's documented link-on-dark)
    brand: "#000000"
    canvas: "#0a0a0b"             # Seam-hider painted on the WEB-VIEW region (view.setBackgroundColor) + window frame edge. NOT the toolbar window bg (that stays transparent for Mica). Pane addition — not in the apple reference.
    surface: "#1d1d1f"            # Toolbar OPAQUE fallback (when backgroundMaterial unavailable). Apple's warm near-black, promoted to surface.
    surface-1: "#272729"          # Popovers, menus, suggestion dropdowns (Apple dark surface 1)
    surface-2: "#2a2a2d"          # Highest elevation (Apple's deepest dark surface). Named "-2" for Pane's 3-step stack; equals Apple's Dark Surface 4 value.
    foreground: "#f5f5f7"         # Primary text / icons on dark (Apple fog, promoted to ink)
    foreground-muted: "rgba(245,245,247,0.62)"   # Secondary text, inactive icons
    foreground-faint: "rgba(245,245,247,0.38)"    # Placeholder, disabled, tertiary
    on-primary: "#ffffff"
    hairline: "rgba(255,255,255,0.09)"            # 1px translucent separators — border as light, never ink
    hairline-strong: "rgba(255,255,255,0.16)"     # Active / focused separators
    danger: "#ff453a"             # Apple iOS system red (dark) — load/connection/cert errors only, never decorative. Pane addition (a browser needs an error signal the marketing reference never did).
    success: "#30d158"            # Apple iOS system green (dark) — secure-connection lock, "copied". Used sparingly. Pane addition (see danger).
  material:
    win11_translucency: "backgroundMaterial: 'mica' (window) / 'acrylic' (flyouts). This is the ONLY source of real window translucency — delivered by the OS compositor, NOT by CSS."
    toolbar_window_bg: "transparent in the toolbar region (root/<body> background unset) so Mica shows through."
    chrome_tint_on_mica: "rgba(22,22,24,0.55)"   # OPTIONAL thin dark tint laid over Mica to deepen it; low alpha so the OS material still reads
    chrome_fill_opaque: "#1d1d1f"                 # fallback when backgroundMaterial is unavailable (Win10 / unsupported) — an honest solid theme, not a material
    popover_blur: "saturate(180%) blur(20px)"     # CSS backdrop-filter — valid ONLY for in-page DOM overlapping other DOM (suggestion dropdown, overflow menu)
    note: "CSS backdrop-filter does NOT blur the desktop behind the window or the sibling native WebContentsView — it only samples DOM layers within the same document. So it is NOT a translucency fallback for the toolbar; window translucency is backgroundMaterial-only. backdrop-filter is used solely on floating in-page popovers."
  typography:
    family:
      ui: "Inter"                 # SF Pro is Apple-proprietary & unlicensable off-platform; Inter (OFL) is the SF-lineage substitute. BUNDLE the font file — it is not preinstalled on Windows, or the fallback silently renders.
      mono: "'JetBrains Mono', 'SF Mono', ui-monospace, 'Cascadia Code', monospace"   # URLs, code, devtools
      fallback: "Inter, 'Segoe UI Variable Text', -apple-system, system-ui, sans-serif"
    native_alt: "Segoe UI Variable is the native Win11 face (optical, preinstalled, zero-bundle). Tradeoff: Inter = brand consistency / cross-platform-ready; Segoe = native Win11 fidelity. v0 is Win11-only, so this is a real choice — Inter chosen for the future canvas/Mac, but bundle it."
    discipline: "Preserve Apple's optical rules: tight negative tracking at every size, weight restraint (text lives at 400/590, bold rare). Never wide-track a neogrotesque."
  spacing: { xs: 2, sm: 4, base: 8, md: 12, lg: 16, xl: 20, section: 24 }   # 8px base. Every padding/gap in the doc snaps to these — no off-scale magic numbers.
  rounded: { xs: 4, sm: 6, md: 8, lg: 12, pill: 980 }   # pill = the address-bar capsule (Apple's signature radius). sm:6 = suggestion rows.
  shadow:
    popover: "0 8px 30px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.06)"   # elevation = soft shadow + hairline ring
    chrome-edge: "inset 0 1px 0 rgba(255,255,255,0.05)"                        # top inner light edge on the toolbar (glass highlight)
  platform:
    window: "Electron BaseWindow + a single WebContentsView for the page. Do NOT use the deprecated BrowserView / addBrowserView. The toolbar is its own transparent WebContentsView (or the window web layer) above the page view."
    wco: "Windows Controls Overlay via titleBarOverlay. The reserved caption-button region is OS-owned and DPI/maximize-dependent — read it at runtime from CSS env(titlebar-area-x/-width/...) + the windowControlsOverlay 'geometrychange' event. Theme buttons via setTitleBarOverlay({color, symbolColor, height}). ~138px at 100% scale is illustrative only; never hard-code it."
  components_harvested: true
  components:
    toolbar:        { type: bar, bg: "Mica (backgroundMaterial) + optional chrome_tint_on_mica; opaque #1d1d1f fallback", height: 48, edge: "shadow.chrome-edge", border-bottom: "1px solid hairline", use: "the single chrome surface above the web view; window bg transparent here for Mica" }
    address-bar:    { type: input, bg: "rgba(255,255,255,0.06)", fg: "foreground", radius: 980, height: 32, padding: "0 12px", font: "13.5px mono", active: "2px ring accent-on-dark + bg rgba(255,255,255,0.09)", drag: "no-drag (must focus/select)", use: "smart omnibox — see §10 parsing contract" }
    nav-button:     { type: icon-button, size: 30, radius: 8, fg: "foreground-muted", hover: "bg rgba(255,255,255,0.08) + fg foreground", disabled: "fg foreground-faint", use: "back / forward / reload" }
    loading-bar:    { type: progress, height: 2, fill: "primary", track: "transparent", motion: "indeterminate trickle, ease only (chrome motion); aborts on did-fail-load", use: "top edge of web view during main-frame navigation" }
    devtools-toggle:{ type: icon-button, size: 30, radius: 8, active: "fg accent-on-dark", behavior: "v0 = dockable right/bottom/detach (per-tab host WebContentsView via setDevToolsWebContents); right-click picks side; side+per-axis size persisted", use: "toggle devtools / right-click to dock" }
    window-controls:{ type: native, platform: "win32 WCO (titleBarOverlay)", reserved: "env(titlebar-area-*) at runtime — not a literal", note: "min/max/close OS-drawn; keep the toolbar right cluster clear of the reserved region; width changes on maximize & DPI", use: "native min/maximize/close" }
    menu:           { type: popover, bg: "surface-1", radius: 12, shadow: "shadow.popover", blur: "popover_blur ok here (DOM over DOM)", item: "13px, 8px 12px, hover bg rgba(255,255,255,0.06)", suggestion-row-radius: 6, use: "overflow / suggestions / context" }
---

# Design System of Pane

> A small, beautiful browser developers want to use every day. The chrome is the product.
> Bootstrapped from the **Apple** reference (inspired mode) — its Clarity / Deference / Depth,
> optical typography, single accent, and Liquid-Glass translucency, re-expressed as a **dark,
> minimal developer browser chrome**. Where Apple's UI defers to the *product*, Pane's chrome
> defers to the *web page*.
>
> **v2 (2026-06-16):** revised after independent design + technical review — translucency
> mechanism corrected (Mica, not `backdrop-filter`), devtools scoped to detached for v0,
> motion story unified to ease-for-chrome, token provenance disclosed, address parser hardened.
>
> **v3 (2026-06-17):** docked devtools delivered — the v2 "roadmap" item shipped. DevTools now
> docks right / bottom (resizable splitter) or detaches, rendering into a per-tab host
> `WebContentsView` via `setDevToolsWebContents`; side + size persisted. §4 / §14 updated.

## 1. Visual Theme & Atmosphere

Pane is controlled drama turned inward. Apple's website uses vast black and near-white expanses as a cinematic stage for products photographed like sculptures; Pane uses a single, quiet, dark stage for the one thing that matters — the web page the developer loaded. The interface retreats until it becomes invisible. This is not minimalism as taste; it is **Deference** — Apple's word — applied to a browser: the chrome exists to serve the content and then get out of the way.

The atmosphere is dark by default. A warm near-black toolbar floats as a single band above a full-bleed web view, separated by one hairline of light rather than a drawn border. On Windows 11 that translucency is **real and OS-delivered**: the window is created with `backgroundMaterial: 'mica'`, and the toolbar region's web background is left transparent so the desktop's Mica tint bleeds faintly through the chrome. This is the same move Apple formalized as Liquid Glass — a material that is *"translucent and behaves like glass… its color informed by surrounding content."* Crucially, the blur comes from the OS compositor, not from CSS: `backdrop-filter` cannot blur the desktop or the native web view behind the toolbar, so it is used only on in-page popovers (see §6). Where Mica is unavailable (Win10), the toolbar falls back to an honest opaque dark fill — a theme, not a fake material.

Typography anchors everything, exactly as it does for Apple. Pane uses **Inter** — the SF-lineage neogrotesque — set with Apple's discipline: tight negative tracking at every size, weight living at 400 and 590, bold reserved for rare emphasis. URLs, code, and devtools are monospace. The result reads machined and precise, never decorative.

The color story is starkly restrained. The entire chromatic budget is spent on one accent: **Apple Blue** (`#0071e3` for fills and focus, `#2997ff` for text-level accent on dark). Everything else is a calibrated grayscale of dark surfaces and translucent white hairlines. A clickable thing is blue; everything else is quiet.

**Key Characteristics:**
- Dark-default chrome: a single translucent toolbar over a full-bleed web view.
- The page is the hero; the chrome defers. Borrowed wholesale from Apple's Deference principle.
- Single accent: Apple Blue (`#0071e3` / `#2997ff` on dark), reserved exclusively for interactive elements.
- Border-as-light: separation comes from 1px translucent-white hairlines and color contrast, not drawn ink borders.
- Inter with Apple's optical discipline — tight negative tracking, weight restraint, mono for URLs/code.
- The smart address bar is a **pill** (980px radius) — Apple's signature capsule, repurposed as the omnibox.
- Real translucency is **OS-delivered** (Win11 Mica via `backgroundMaterial` ↔ Liquid Glass), never a CSS `backdrop-filter` trick — with an honest opaque fallback off Win11.
- Motion is quiet: **ease curves for chrome** now; spring physics wait for the gesture surfaces (tab drag, the future canvas) that v0 doesn't have yet.

## 2. Color Palette & Roles

### Canvas & Surfaces (dark-default)
- **Canvas** (`#0a0a0b`): The seam-hider. Painted on the **web-view region** (`webContentsView.setBackgroundColor`) and the window frame edge so a momentary resize gap reads as intentional dark, not a flash. It is **not** the toolbar's window background — that stays transparent for Mica. Near-black, faintly warm. *(Pane addition — see §6 and the provenance note.)*
- **Surface** (`#1d1d1f`): The toolbar's **opaque fallback** fill, used when `backgroundMaterial` is unavailable. Apple's warm near-black ink, promoted to a chrome surface. Reads premium, never flat-gray.
- **Surface 1** (`#272729`): Popovers, overflow menus, the address-bar suggestion dropdown. Apple dark surface 1.
- **Surface 2** (`#2a2a2d`): Highest elevation — a menu on a menu, active flyout. *(Named for Pane's 3-step stack; the value equals Apple's "Dark Surface 4".)*

### Interactive (the only chroma)
- **Apple Blue** (`#0071e3`): Primary fills, focus rings, the active state of a toggle. The ONLY chromatic color on solid/fill use.
- **Bright Blue** (`#2997ff`): Text-level accent on dark — links, the active devtools icon, the address-bar focus ring. Higher luminance for legibility on near-black.

### Text & Icons (on dark)
- **Foreground** (`#f5f5f7`): Primary text and active icons. Apple's fog gray, promoted to ink on dark — softer than pure white, easier on the eyes for an all-day tool.
- **Foreground Muted** (`rgba(245,245,247,0.62)`): Secondary text, inactive toolbar icons, the resting address-bar URL.
- **Foreground Faint** (`rgba(245,245,247,0.38)`): Placeholder text, disabled controls, tertiary labels.
- **On-Primary** (`#ffffff`): Text/icon on a blue fill.

### Hairlines (border as light, not ink)
- **Hairline** (`rgba(255,255,255,0.09)`): The 1px separator under the toolbar, between menu items, around inputs. Light *added*, never a dark line drawn.
- **Hairline Strong** (`rgba(255,255,255,0.16)`): Hover/active separators, the address bar's resting edge.

### Status (semantic, never decorative)
- **Danger** (`#ff453a`): Apple's iOS system red (dark). Page-load failures, certificate errors, blocked navigation. Never used for emphasis or accent. *(Pane addition — not in the marketing reference; chosen to match Apple's system palette.)*
- **Success** (`#30d158`): Apple's iOS system green (dark). Secure-connection lock, "copied" confirmations. Used sparingly. *(Pane addition — see Danger.)*

### Material (the toolbar's translucency)
- **Win11**: `backgroundMaterial: 'mica'` supplies the translucency; the toolbar web region is transparent so it shows through; an optional thin tint `rgba(22,22,24,0.55)` deepens it without killing the material.
- **Fallback (no Mica)**: opaque `#1d1d1f` — an honest solid theme.
- **`backdrop-filter`** (`saturate(180%) blur(20px)`) is used **only** on floating in-page popovers (suggestion dropdown, overflow menu) that overlap the toolbar's own DOM. It does **not** blur the desktop or the native web view.

**Budget rule:** one accent (blue), two semantic colors (red, green), everything else grayscale. If a third hue appears, something is wrong.

## 3. Typography Rules

### Font Family
- **UI**: `Inter` — variable, optical, SF-lineage. Used for all chrome text. *(SF Pro is Apple-proprietary and cannot ship off Apple platforms; Inter, under the SIL Open Font License, is the closest honest substitute. **Bundle the font file** — Inter is not preinstalled on Windows, so relying on it silently falls back.)*
- **Native alternative**: `Segoe UI Variable` is the native Win11 face — optical, preinstalled, zero-bundle. Tradeoff: **Inter** for brand consistency and cross-platform readiness (the future canvas / a Mac build) vs. **Segoe UI Variable** for maximum native-Win11 fidelity. v0 is Win11-only, so this is a genuine choice; Inter is the default here, but Segoe is a defensible swap.
- **Mono**: `'JetBrains Mono', 'SF Mono', ui-monospace, 'Cascadia Code', monospace` — URLs in the address bar, code, devtools, anything that must align by character.
- **Fallback stack**: `Inter, 'Segoe UI Variable Text', -apple-system, system-ui, sans-serif`.

### Hierarchy (chrome lives at the small end of the scale)

| Role | Font | Size | Weight | Line Height | Tracking | Use |
|------|------|------|--------|-------------|----------|-----|
| New-tab Display | Inter | 40px | 590 | 1.08 | -0.02em | New-tab / start-page greeting (the rare large moment) |
| Section | Inter | 24px | 590 | 1.16 | -0.015em | Settings section titles |
| Title | Inter | 17px | 590 | 1.24 | -0.011em | Dialog titles, prompts |
| Body | Inter | 14px | 400 | 1.45 | -0.006em | Settings body, menu descriptions |
| **URL / Address** | **Mono** | **13.5px** | **400** | **1.0** | **0** | The address bar — monospace so URLs read true |
| Control label | Inter | 13px | 400 | 1.0 | -0.004em | Toolbar labels, menu items, tab titles |
| Caption | Inter | 12px | 400 | 1.3 | -0.002em | Hints, suggestion subtitles, status text |
| Micro | Inter | 11px | 500 | 1.3 | 0 | Badges, keyboard-shortcut hints |

### Principles
- **Optical discipline, borrowed from Apple**: tight negative tracking at every size (not just headlines). Inter at chrome sizes wants `-0.004em` to `-0.011em`; never positive tracking.
- **Weight restraint**: text lives at 400; emphasis at 590 (Inter's "semibold"). Bold (700) is rare. No 300 hairline weights in chrome — they smear on sub-pixel toolbars.
- **Mono for truth**: the address bar, code, and devtools are monospace so a URL never lies about its characters (`l` vs `1`, `O` vs `0`). This is a security affordance as much as an aesthetic one.
- **One idea per surface**: a menu item is one line. A prompt is one sentence. Density comes from tight type, not crowded copy.

## 4. Component Stylings

Pane runs **one chrome surface** — the toolbar — and a small kit of controls inside it. Every control follows Apple's component grammar: pill or soft-rect geometry, a single blue accent, no drawn borders (hairlines only), elevation by color/blur rather than heavy shadow.

### The Toolbar (the chrome)
- Background: **Win11** → transparent window region over `backgroundMaterial:'mica'`, with an optional `rgba(22,22,24,0.55)` deepening tint. **Fallback (no Mica)** → opaque `#1d1d1f`.
- Height: 48px
- Top edge: `inset 0 1px 0 rgba(255,255,255,0.05)` — a faint glass highlight
- Bottom: `1px solid rgba(255,255,255,0.09)` hairline separating chrome from page
- Layout: left cluster (nav buttons) · address pill (**left-anchored** right after the nav cluster, flexes to fill toward the right cluster, capped at `max-width: 1080px`) · right cluster (devtools, overflow) · **reserved WCO region** (window controls) at far right on Windows, sized via `env(titlebar-area-width)`. *(v2.1: the pill was originally center-floated; that stranded it with large dead gaps, so it is now left-anchored and fills the available width.)*
- Drag: the bar is `-webkit-app-region: drag`; **every** interactive control inside it — buttons *and the address input* — is `no-drag`.

### Smart Address Bar (the pill)
- Background: `rgba(255,255,255,0.06)` resting → `rgba(255,255,255,0.09)` focused
- Text: `foreground` (focused), `foreground-muted` (resting URL); **monospace 13.5px**
- Radius: **980px** (full pill — the signature capsule)
- Alignment: **left-anchored** — starts ~8px after the reload button and flexes to fill toward the right cluster (`width:100%; max-width:1080px`), so it reads as the connected primary control rather than a centered island. (The new-tab/start-page pill stays centered — that's a different surface, §14.)
- Height: 32px; padding: **0 12px** (on the spacing scale)
- Resting edge: `1px solid rgba(255,255,255,0.16)`; **Focus: 2px ring `#2997ff`** (no glow, no shadow)
- Drag: `-webkit-app-region: no-drag` — caret placement and text selection must work
- Leading slot: a 16px security/status glyph (lock = `#30d158`, warning = `#ff453a`, search = muted)
- Behavior: see §10 for the ordered parsing contract.

### Navigation Buttons (back / forward / reload)
- Icon button: 30×30, radius 8px, icon 18px
- Resting: `foreground-muted` · Hover: bg `rgba(255,255,255,0.08)`, icon → `foreground` · Active/press: bg `rgba(255,255,255,0.12)`
- Disabled (no history): icon `foreground-faint`, no hover
- Reload ↔ Stop swaps glyph during loading; the swap is a 150ms opacity crossfade, never a layout shift

### Loading Bar
- A 2px line pinned to the **top edge of the web view** (just under the toolbar hairline)
- Fill: `#0071e3` (solid blue, no gradient); track: transparent
- Events (these are *navigation* signals, not byte progress): start on `did-start-loading` (and `did-start-navigation` filtered to `details.isMainFrame && !details.isSameDocument`, so SPA route changes and subframes don't re-trigger it); complete on `did-stop-loading`; **abort/complete on `did-fail-load`** so a failed navigation never leaves the bar stuck at the wall.
- Motion: indeterminate **trickle**, **ease only** (it is chrome, not a gesture) — eases 0→80% (`ease-out`) on start, holds, then completes 80→100% (`ease-standard`) and fades over 200ms. Progress is *felt*, not faked-precise (Chromium gives no true main-frame byte progress).
- This is Pane's signature motion (see §15).

### DevTools Toggle
- Icon button (same 30×30 grammar)
- Active (devtools open): icon → `#2997ff`; otherwise `foreground-muted`
- **v0 behavior**: **dockable** — dock **right**, dock **bottom**, or **detach**. Right-click the toggle to choose; the dock side and per-axis size are **persisted**. Because native Chromium docking ignores a custom `WebContentsView` layout (it docks relative to the host window), Pane renders devtools into a **per-tab host `WebContentsView`** via `setDevToolsWebContents(host) + openDevTools({ mode: 'detach' })` — the `detach` mode only keeps Chromium from spawning its own window; Pane then tiles `page │ splitter │ devtools` itself and resizes the dock with a thin splitter view. **Detach** reparents that same host view into a satellite `BaseWindow`. This is the `BaseWindow` + multiple-`WebContentsView` foundation paying off (§5).

### Window Controls (native)
- Windows 11: native **WCO** via `titleBarOverlay` — min/maximize/close drawn by the OS.
- The reserved caption region is **OS-owned and runtime-variable** (DPI scale, maximize↔restore): reserve the toolbar's right edge using CSS `env(titlebar-area-x/-width/-height)` and recompute on the `windowControlsOverlay` `geometrychange` event. **Never hard-code a pixel width** (~138px at 100% scale is illustrative only and breaks at 125/150% — the Win11 laptop default).
- Theme the caption buttons to the dark chrome via `setTitleBarOverlay({ color, symbolColor, height })`.
- Rationale in §8; this is the single biggest platform constraint on the layout.

### Menu / Suggestion Popover
- Background: `surface-1` (`#272729`); radius 12px; suggestion **rows** use `radius 6` (`rounded.sm`)
- Shadow: `0 8px 30px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.06)` (soft shadow + hairline ring — Apple's "elevation by light")
- This popover floats over the toolbar's own DOM, so `backdrop-filter: saturate(180%) blur(20px)` is **valid here** (DOM over DOM) and may be layered under the tint for extra depth.
- Item: 13px Inter, padding 8px 12px, hover bg `rgba(255,255,255,0.06)`, selected text `foreground` with a leading accent tick
- Suggestion rows: mono URL + Inter caption subtitle; the matched substring is `foreground`, the rest `foreground-muted`

## 5. Layout Principles

### The Shell
Two regions, no more: a **48px toolbar** and a **full-bleed web view** filling everything below it. The window is an Electron **`BaseWindow`**; the page is a single native **`WebContentsView`** repositioned with `setBounds` on resize (not an iframe, no zoom, no canvas). The toolbar is its own transparent `WebContentsView` (or the window web layer) above the page. **Do not use the deprecated `BrowserView` / `addBrowserView`** — and the `BaseWindow` + multiple-`WebContentsView` foundation is exactly what the future canvas and docked-devtools both need. The chrome is HTML/CSS; the page is native. They meet at one hairline.

### Spacing System
- Base unit: **8px**. Scale: `{xs:2, sm:4, base:8, md:12, lg:16, xl:20, section:24}`. Every gap/padding in this doc snaps to a scale step — no off-scale magic numbers.
- Toolbar internal rhythm: 8px between clusters, 4px between sibling icon buttons, 12px address-pill side padding.
- "Compression within, expansion between," exactly as Apple: tight type, generous breathing room around it.

### Window
- Default size: 1200×800. **Minimum: 640×480** (below the floor the right cluster collapses into overflow; the address pill drops its leading status text to a glyph — see §8 for the exact bands).
- Frameless (`frame: false`), custom toolbar, native window controls via WCO.
- The toolbar is a `-webkit-app-region: drag` surface; every interactive control inside it (buttons **and** the address input) is `no-drag`.

### Resize Integrity (the make-or-break detail)
The chrome (HTML, renderer process) and the web view (native) resize on different timelines. Done naively, the page lags the toolbar during a drag-resize and a dark gap flashes — the single tell of a cheap Electron wrapper, and the fastest way to lose the "beautiful" claim. Mitigations are first-class layout requirements, not polish:
- **Reposition synchronously in the main process**, in the window's `'will-resize'` / `'resize'` handler — *not* throttled behind the renderer's `requestAnimationFrame`. A Windows drag-resize runs in a modal move/size loop that can starve renderer rAF, so rAF-gating the `setBounds` makes the native view lag *more*. (Reserve rAF-style coalescing for programmatic, non-drag resizes.)
- **Paint the seam-hider on the web-view region only** — `webContentsView.setBackgroundColor('#0a0a0b')` (and the page background) — so a momentary gap reads as intentional dark. Do **not** paint an opaque background on the *window*/toolbar region: that would kill Mica. (This is the explicit resolution of the translucency↔seam coupling.)
- **Overlap the web view a few px under the toolbar's translucent edge** so the seam is never bare — keep the overlap to a hairline + a pixel or two so chrome doesn't clip page content.

Treat resize jank as a P0 visual bug.

### Border Radius Scale
- `xs 4px` — badges, tight chips · `sm 6px` — suggestion rows · `md 8px` — icon buttons, menu inner items · `lg 12px` — popovers, dialogs · `pill 980px` — the address bar and any standalone CTA.
- Rectangular chrome stays ≤12px. The pill is reserved for the capsule shapes (address bar) — Apple's rule, kept verbatim.

## 6. Depth & Elevation

Depth is Apple's third principle, and in Pane it is carried by **translucency and light**, not by stacked shadows.

| Level | Treatment | Use |
|-------|-----------|-----|
| Page (Level 0) | The web view. No chrome, no shadow. | The content — the actual hero |
| Chrome glass | **Mica** (`backgroundMaterial`) supplies the blur; transparent toolbar web bg + optional `rgba(22,22,24,0.55)` tint + inset top light + bottom hairline. NOT `backdrop-filter`. | The toolbar floating over the page |
| Resting control | No shadow; a translucent-white fill on hover only | Nav buttons, devtools toggle |
| Focused input | `2px #2997ff` ring, no glow | The address bar when active |
| Popover (Level 1) | `0 8px 30px rgba(0,0,0,0.45)` + `0 0 0 1px rgba(255,255,255,0.06)` hairline ring; `backdrop-filter` blur valid here (DOM over DOM) | Menus, suggestion dropdown |
| Focus (a11y) | `2px solid #0071e3` outline | Keyboard focus on every interactive element |

**Shadow philosophy.** Like Apple, Pane uses shadow sparingly and softly — one diffuse shadow for floating popovers, nothing elsewhere. On a dark surface, elevation reads better as **a step lighter** (`#1d1d1f` → `#272729` → `#2a2a2d`) plus a hairline ring than as a heavy drop shadow. The toolbar's "depth" is the **real Mica blur** from the OS compositor, not a CSS imitation. This is Apple's Depth principle promoted from metaphor to material — the same move as Liquid Glass.

## 7. Do's and Don'ts

### Do
- Get the chrome's translucency from **`backgroundMaterial: 'mica'`** and keep the toolbar-region **window background transparent** so it shows through. The material is the identity.
- Spend the entire chromatic budget on **one accent** (Apple Blue `#0071e3` / `#2997ff` on dark).
- Separate surfaces with **1px translucent-white hairlines** and color contrast — light added, not ink drawn.
- Set the address bar in **monospace** and shape it as a **pill** (980px).
- Apply **tight negative tracking** to Inter at every size; live at weights 400/590. Bundle the font.
- Let the **web page be the hero** — chrome recedes, hover-reveals where it can, never competes.
- Treat **resize integrity** as a P0 requirement: main-process `'will-resize'` `setBounds`, seam-hider on the web-view region, overlap the seam.
- Use **ease curves for chrome motion**. Reserve spring physics for gesture surfaces that arrive later.

### Don't
- Don't expect CSS **`backdrop-filter` to blur the desktop or the web view** — it only blurs DOM behind DOM. Use it for in-page popovers only; never as the toolbar's translucency.
- Don't paint an **opaque window/toolbar background** — it kills Mica. Paint the seam-hider on the web-view region instead.
- Don't **hard-code the WCO width** (e.g. 138px) — read `env(titlebar-area-*)` at runtime; it changes with DPI and maximize.
- Don't dock devtools into the custom chrome in v0 — open it **detached**.
- Don't introduce a second accent color — no purple, no gradient CTAs. Blue is the whole budget.
- Don't draw dark ink borders; don't stack multiple shadows. One soft shadow on popovers, hairlines everywhere else.
- Don't wide-track Inter or use 300-weight text in the toolbar — it smears at chrome sizes.
- Don't fake precise load progress, and don't let the bar hang — it trickles, completes on stop, and aborts on `did-fail-load`.
- Don't let chrome motion bounce or spring — physics is for gestures, which v0 doesn't have.

## 8. Responsive Behavior

A desktop browser's "responsive" axis is **window size and platform chrome**, not mobile breakpoints.

### Window Width Behavior
| Width | Toolbar behavior |
|-------|------------------|
| ≥ 1024px | Full layout: nav cluster · wide address pill · devtools + overflow · WCO |
| 768–1024px | Address pill narrows; secondary controls stay |
| 640–768px | Address pill drops its leading status label to a glyph-only; right cluster begins collapsing into overflow (`⋯`) |
| < 640px (min window) | Nav + address pill + overflow + WCO only |

### Platform Chrome (critical)
- **Windows 11**: native window controls via `titleBarOverlay` (WCO). The overlay reserves a top-right region whose size is **OS-owned and variable** — read it from CSS `env(titlebar-area-x/-y/-width/-height)` and the `windowControlsOverlay.getBoundingClientRect()` + `geometrychange` event; pad the toolbar's right edge to it. It changes with **DPI scale** (125/150/175% are the laptop defaults) and on **maximize↔restore** (the glyph and strip width shift), so never assume a constant. Theme the buttons via `setTitleBarOverlay({ color, symbolColor, height })`. The overlay sits **on top of** the toolbar's top-right, so nothing interactive may live under it; and don't double-cover the OS-draggable WCO area with your own drag region.
- **macOS (future)**: `titleBarStyle: 'hidden'` with `trafficLightPosition` to inset the native traffic lights into the left of the toolbar. The reserved region moves left; mirror the layout.
- Never hand-draw window controls — use the OS ones, themed. Hand-drawn min/close is the second-biggest "cheap Electron" tell after resize jank.

### Density
- The toolbar height (48px) is fixed across sizes — chrome does not scale with the window; only its horizontal contents reflow.
- The web view always takes 100% of the remaining space, edge to edge.

## 9. Agent Prompt Guide

### Quick Color Reference (dark-default)
- Accent / focus: `#0071e3` (fills) · `#2997ff` (on-dark text accent)
- Toolbar: Mica (`backgroundMaterial`) + transparent web bg + optional `rgba(22,22,24,0.55)` tint; opaque `#1d1d1f` fallback
- Web-view seam-hider / canvas: `#0a0a0b` (on the view region, not the window)
- Elevated surface: `#272729` → `#2a2a2d`
- Text: `#f5f5f7` / muted `rgba(245,245,247,0.62)` / faint `rgba(245,245,247,0.38)`
- Hairline: `rgba(255,255,255,0.09)` (separators) / `rgba(255,255,255,0.16)` (active)
- Error: `#ff453a` · Secure: `#30d158`
- Popover shadow: `0 8px 30px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.06)`

### Example Component Prompts
- "Build Pane's toolbar as a 48px bar with a **transparent** background (the Electron window uses `backgroundMaterial:'mica'`, so the desktop shows through); optionally overlay `rgba(22,22,24,0.55)` to deepen it. Add `inset 0 1px 0 rgba(255,255,255,0.05)` top edge and a `1px solid rgba(255,255,255,0.09)` bottom hairline. Left: three 30×30 icon buttons (back, forward, reload) in `rgba(245,245,247,0.62)`. Then a left-anchored, flexible address pill that fills toward the right cluster (`width:100%; max-width:1080px`). Right: devtools toggle + overflow, then reserve the window-controls gap with `padding-right: env(titlebar-area-width)`. The bar is `-webkit-app-region: drag`; every control including the address input is `no-drag`. Do NOT use `backdrop-filter` here."
- "Build the smart address bar: a full-pill input (`border-radius: 980px`), 32px tall, `rgba(255,255,255,0.06)` fill, `1px solid rgba(255,255,255,0.16)` border, monospace 13.5px text in `#f5f5f7`, padding `0 12px`, `-webkit-app-region: no-drag`. A 16px leading status glyph (lock/search). On focus: fill `rgba(255,255,255,0.09)` and a `2px solid #2997ff` ring (no glow). No drop shadow."
- "Build the loading bar: a 2px line at the top of the web view, fill `#0071e3`. Start the trickle on `did-start-loading`/main-frame `did-start-navigation`; ease width 0→80% over ~1.4s `ease-out`; on `did-stop-loading` ease 80→100% then fade opacity to 0 over 200ms; on `did-fail-load` complete-and-fade immediately so it never hangs. No gradient, no spring."
- "Build the suggestion dropdown: `#272729` panel, 12px radius, rows at 6px radius, shadow `0 8px 30px rgba(0,0,0,0.45)` plus a `0 0 0 1px rgba(255,255,255,0.06)` ring; `backdrop-filter: blur(20px)` is fine here. Rows 8px/12px padding; mono URL + 12px Inter subtitle; matched substring `#f5f5f7`, rest `rgba(245,245,247,0.62)`; selected row hover `rgba(255,255,255,0.06)` with a leading `#2997ff` tick."
- "Build the new-tab start page: `#0a0a0b` background, a single centered 40px Inter/590 greeting at `-0.02em` tracking in `#f5f5f7`, and one centered address pill. Nothing else. Deference."

### Iteration Guide
1. Every interactive element gets Apple Blue — no other accent.
2. Translucency is Mica from `backgroundMaterial` with a transparent toolbar web bg — not `backdrop-filter`. Fallback is an honest opaque `#1d1d1f`.
3. Inter (bundled) with tight negative tracking; mono for URLs/code; weights 400/590.
4. Separation = hairlines + color steps, never dark drawn borders.
5. The address bar is a monospace pill; focus is a 2px blue ring, not a glow; it's `no-drag`.
6. Resize stays seamless: main-process `'will-resize'` `setBounds`, seam-hider on the web-view region, overlap the seam.
7. Shadow is rare and soft; elevation on dark is "a step lighter."
8. Motion is ease for chrome; the loading bar aborts on `did-fail-load`. Spring is for future gestures only.

## 10. Voice & Tone

Pane's UI copy is terse, precise, and developer-peer — Apple's clarity discipline spoken to someone who reads stack traces. There is very little copy (it's a browser chrome), so every word is load-bearing. Short declaratives. Periods, not exclamations. Specific over reassuring.

| Context | Tone |
|---|---|
| Address-bar placeholder | Plain, inviting. "Search or enter address." |
| Load error (network) | Specific cause + one action. "Can't reach example.com. Check the address or your connection." Never "Something went wrong." |
| Load error (DNS / invalid) | "example.dev doesn't resolve. Search instead?" with a one-tap search affordance. |
| Certificate / insecure | Factual, non-alarmist, but firm. "This connection isn't private." No emoji, no scare-color flood. |
| Empty new tab | Silence, mostly. A greeting at most; no tips, no widgets. |
| Confirmations | Quiet and brief. "Copied." appears where the action happened, fades. No toast spam. |
| Keyboard hints | Mono keys, plain verbs. "Ctrl+L Focus address" / "Ctrl+Shift+I DevTools". |

### The address-bar parsing contract (v0's one piece of real logic — get it right or developers notice in 0.5s)

An **ordered** pipeline; the first matching rule wins. Precedence is explicit — an earlier rule is never overridden by a later one.

1. **Trim** input. Empty → no-op.
2. **Explicit valid scheme** (`http://`, `https://`, `file://`, plus whitelisted `about:blank`) → **load as-is**. A present scheme is authoritative — never re-assume `http://` over it. Route other `about:` tokens to internal pages, not `loadURL`. Decide `file://` policy explicitly: v0 allows it but normalizes Windows paths (`C:\…`, backslashes, drive letters) first.
3. **Loopback / IP** — `localhost`, `localhost:PORT`, `127.0.0.1`, `::1` / `[::1]:PORT`, IPv4`[:PORT]`, bracketed IPv6`[:PORT]` → **load** (`http://` assumed, `https://` for `:443`). Handle the bracket syntax so the IPv6 colons don't collide with the port separator.
4. **Bare host** — no whitespace, AND the host's public suffix is in the **Public Suffix List** (not a hand-rolled TLD set), AND it is not on a small "looks-like-a-package" denylist (`socket.io`, `node.js`, `vue.js`, `next.js`, …) → **load**. Normalize IDN to **punycode** for the decision and display per Chromium's spoof rules (a Clarity obligation — a homograph host must not lie).
5. **Single-label token** (`jira`, `wiki`, `grafana`) → **search** by default, with "Go to `<host>`" as suggestion #1. **Never block the keystroke on synchronous DNS.** Optionally fire async DNS and upgrade the suggestion if it resolves.
6. **Everything else** (spaces, prose, a dotted phrase like `node.js tutorial`, or a denylisted token) → **search**; if it could plausibly be a host, surface "Go to `<x>`" as suggestion #1.

The TLD-vs-library conflict (`socket.io` has a real `.io` TLD but is usually a search) resolves to **search + Go-to suggestion**, not auto-load — rule 4's denylist yields to ambiguity, never the reverse.

**Forbidden.** Exclamation marks in chrome. Emoji anywhere in the UI. "Oops" / "Uh-oh" / apology theater. Generic "Something went wrong." Marketing superlatives ("blazing-fast", "the best browser"). Scare-flooding a whole surface red for a routine cert warning. Faked precise progress percentages.

## 11. Brand Narrative

Pane is a developer's browser whose entire thesis is a refusal: a browser does not need to be a platform, an account, or a feature mall to be worth opening. It needs to be **fast, honest, and beautiful enough to want open all day**. The product's value lives almost entirely in its chrome — the hand-built HTML/CSS toolbar and the calm dark frame around the page — so that is where all the energy goes.

The design lineage is explicit and narrow. From **Apple's Human Interface Guidelines**, Pane takes the three anchor principles — *Clarity* (a URL reads true, an icon means one thing), *Deference* (the chrome steps back so the page is the hero), and *Depth* (translucency and motion convey hierarchy, not decoration) — and the contemporary expression of Depth as **material**: the Mica toolbar is Pane's Liquid Glass. From **Arc and Zen**, Pane takes the conviction that a browser can be quiet, dark, and personal — UI that hides until needed — without becoming a productivity suite.

What Pane refuses is as defining as what it embraces. It is **not** a Chromium or Firefox fork (too heavy for a dev tool); it does not chase Google-account login (irrelevant for development — hand off to the system browser when a site demands it); it does not bolt on a terminal, an editor, a database client, an AI agent, or an infinite canvas in its first milestone. The scope is one sentence: *a beautiful browser for developers.* The roadmap — tabs, then optional runtime/devtools depth, then an optional **infinite-canvas mode where many Pane instances float and arrange on one surface** — is real but deliberately deferred. v0 stays ruthlessly narrow: type a URL, and a real site appears inside a frame worth looking at.

<!-- omd:limitation — §11 is written from the project brief (a stated design thesis), not a corporate history. Pane is pre-release; there is no founding date, company, or public tagline to cite. Replace with real facts when they exist; do not fabricate a history. -->

## 12. Principles

1. **Deference — the chrome serves the page.** The web content is the product; the toolbar exists to load it and get out of the way. Every chrome decision is judged against "does this let the page be the hero?" *(HIG principle, applied to a browser.)*
2. **Clarity — a URL never lies.** Monospace addresses, precise status glyphs, specific error copy, punycode-normalized host decisions. The user can always tell where they are and whether it's secure. *(HIG principle.)*
3. **Depth is material, not decoration.** Elevation comes from real OS translucency (Mica), color steps, and hairlines of light — not from stacked shadows or a CSS `backdrop-filter` imitation. *(HIG Depth → Liquid Glass, applied.)*
4. **One accent, spent on action.** Apple Blue marks what is interactive and nothing else. A surface with two accent hues is a bug.
5. **Beauty is the product, so beauty is a requirement.** A resize seam, a janky loading bar, a smeared font at a sub-pixel size — these are not polish items, they are defects. If it isn't beautiful under motion and resize, it isn't done.
6. **Scope discipline is a design principle.** Every feature not in the current milestone is a feature that can't make v0 ugly or slow. Say no to keep the one thing excellent. The infinite-canvas future is earned by a flawless single pane first.
7. **Border as light.** Separate with translucent-white hairlines and contrast, never dark ink lines. Light is added to a dark surface; the surface is never cut.
8. **Honest mechanism.** Use the platform's real capability (Mica for translucency, the OS for window controls, navigation events for the load bar) instead of a CSS trick that only looks right in a screenshot. The spec must be true when built, not just when described.
9. **Honest feedback.** Progress that can't be measured is *felt* (trickle), not faked (precise %); the bar aborts on failure rather than hanging. Errors state the specific cause and one recovery path. No apology theater.
10. **Inter, with Apple's discipline.** One typeface family (bundled), tight tracking, restrained weights, mono for truth. Substituting a decorative font breaks the voice even if it looks superficially similar.

## 13. Personas

*Fictional archetypes informed by the target segment — developers who keep a browser open beside their editor all day. Not real individuals.*

**Hyun, 31, Seoul.** Front-end engineer. Lives in `localhost:3000` and a code editor side by side. Wants a browser that boots instantly, makes a dev server feel native, and isn't screaming for a sign-in. Will judge Pane in the first five minutes on exactly two things: does the address bar do the right thing with `localhost:5173` (and `jira`, and `socket.io`), and does the window resize without a flicker. Keeps Chrome open only for the occasional Google-login site.

**Mara, 38, Berlin.** Design engineer who notices sub-pixel seams and 1px misalignments the way others notice typos. Chose her tools — Arc, Zen, Raycast — for their craft, not their feature lists. Pane wins her if the Mica blur is real and the motion has weight; it loses her instantly if a load bar stutters or hangs, or a border looks drawn-on. She is the user the whole "beauty is the product" thesis is for.

**Diego, 26, São Paulo.** Full-stack dev, multi-monitor, dozens of tabs in his main browser. Curious about Pane for the *future* — the infinite-canvas mode where he can park a staging site, a localhost build, and the docs on one surface. For now he uses v0 as a clean second browser for focused work and watches the roadmap. He's why the canvas future is in the narrative even though it's not in v0.

## 14. States

| State | Treatment |
|---|---|
| **New tab / start** | `#0a0a0b` background, a single centered greeting (40px Inter/590) and one address pill. No widgets, no tips. Deference made literal. |
| **Loading (navigation)** | The 2px blue trickle bar at the top of the web view (main-frame navigations only); reload glyph swaps to stop. Toolbar otherwise still — no spinner cursor, no skeleton over the page. |
| **Loaded** | Bar completes 80→100% (ease) and fades over 200ms; address bar shows the resolved URL in `foreground-muted`, security glyph updated. |
| **Empty (blank page)** | If a site renders nothing, the web view is simply `canvas` color — Pane never injects a placeholder over the page's own area. |
| **Error (network / unreachable)** | The loading bar aborts (`did-fail-load`) and a Pane-rendered error surface paints on `canvas`: short mono URL, one-sentence specific cause in `foreground`, one action (Retry / Search instead) as a blue pill. No illustration, no emoji. |
| **Error (invalid / unresolved address)** | Inline: the address bar offers "Search for `<query>`" as the top suggestion rather than throwing an error. |
| **Insecure / cert warning** | Security glyph → `#ff453a`; an interstitial states the specific problem and the risk in plain language, with a deliberately un-styled (not blue) "proceed anyway" link. Firmness without theater. |
| **DevTools open** | Devtools toggle icon → `#2997ff`; devtools docks **right / bottom** (resizable via a splitter) or **detaches** to its own window — right-click the toggle to choose; the side and size are remembered. The page reflows to make room; the toolbar height is unaffected. |
| **Focused address bar** | Fill lightens to `rgba(255,255,255,0.09)`, `2px #2997ff` ring, full URL selected, suggestion dropdown opens beneath. |
| **Disabled control** | Icon → `foreground-faint`; no hover; geometry unchanged (a disabled pill stays a pill). Applies to nav buttons with no history. |
| **Window blurred (app not focused)** | Mica goes **inert** per the OS — a subtle shift (Mica is a window-background material tied to the wallpaper, so it does not desaturate strongly the way Acrylic would). Accent stays but reads muted. Matches native Win11 inactive-window behavior. |

## 15. Motion & Easing

**Durations**

| Token | Value | Use |
|---|---|---|
| `motion-instant` | 0ms | State commits, selection confirm |
| `motion-fast` | 150ms | Hover, icon crossfade (reload↔stop), the address-ring draw-in, tap feedback |
| `motion-standard` | 300ms | Menu/popover open; the loading-bar completion leg |
| `motion-slow` | 500ms | New-tab entrance, settings transitions |
| `motion-spring` | physics | **Reserved** — future gesture surfaces (tab drag, the canvas). v0 chrome has no gestures, so it uses ease, not spring. |

**Easings**

| Token | Curve | Use |
|---|---|---|
| `ease-enter` | `cubic-bezier(0.2, 0.6, 0.25, 1)` | Popovers, dropdowns arriving |
| `ease-exit` | `cubic-bezier(0.4, 0.0, 1, 1)` | Dismissals, fades-out |
| `ease-standard` | `cubic-bezier(0.25, 0.1, 0.25, 1)` | Two-way chrome transitions; loading-bar completion |
| `ease-spring` | spring (mass / stiffness / damping) | Gesture-driven motion — **not present in v0** |

**Philosophy.** Pane chrome moves on **ease curves** — quick and quiet, so it never taxes an all-day tool. Apple's **spring physics** are inherited but deliberately parked: they belong to gesture surfaces (swipe, drag, pull, rubber-band), and v0 — a single static `WebContentsView` — has none of those. When gestures arrive (tab drag, the canvas), spring arrives with them. Until then, no chrome element springs or bounces.

**Signature motions.**
1. **The trickle loading bar.** Eases 0→80% on navigation start (`ease-out`), holds at the wall, then completes 80→100% (`ease-standard`) on `did-stop-loading` and fades. On `did-fail-load` it completes-and-fades immediately so it never hangs. Felt progress (no true main-frame byte signal), never faked precision, and pure ease — it is chrome, not a gesture. Pane's most-seen motion: it must feel alive but calm.
2. **Address-bar focus.** On focus the pill's fill lightens and the `#2997ff` ring draws in over 150ms; the suggestion dropdown rises with `ease-enter`. No scale, no glow.
3. **Reload ↔ Stop crossfade.** The glyph swaps via 150ms opacity crossfade during loading — never a layout shift or a spin-jank.
4. **Toolbar settle on resize.** The web view tracks the window via synchronous main-process `setBounds`; the goal is *no perceptible lag* between chrome and page. The toolbar's translucent edge overlaps and covers the seam.
5. **Reduce motion.** Under `prefers-reduced-motion: reduce`, the trickle bar becomes a simple two-step fill, popovers crossfade instead of rising, and any future spring motion degrades to instant. Respected at the OS level on Win11.

<!--
OmD v0.1 — Pane DESIGN.md, bootstrapped from `apple` (inspired mode), 2026-06-16.
v2 (2026-06-16): applied an independent two-lane review (design/consistency + Electron/Win11 technical).

Token provenance — values NOT present in the apple reference (disclosed honestly; also recorded in .omd/init-context.json warnings):
- canvas `#0a0a0b` — Pane addition. The apple reference's only true-dark base is #000000. Used as the web-view-region seam-hider, not the window bg.
- danger `#ff453a` / success `#30d158` — Pane additions. These are Apple's iOS system red/green (dark), NOT in the marketing reference; a browser needs load-error and secure-state signals the reference never required. Selected to match Apple's system palette, not invented arbitrarily.
- chrome tint `rgba(22,22,24,0.55)` and opaque fallback `#1d1d1f` for the toolbar — Pane additions (the reference's translucent surfaces are rgba(0,0,0,0.8)/fog). #1d1d1f is the apple reference's text near-black, reused as a surface.
- hairline opacities, 2px loading bar, WCO reserved region, resize-integrity tokens — app-chrome necessities with no marketing-page analogue.

Surface mode + domain + typeface adaptations: dark-default selected from Apple's own documented dark palette (#000000/#1d1d1f/#272729/#2a2a2d); consumer-marketing → browser chrome (component nouns swapped, Apple's styling grammar preserved: 980px pill, single accent, border-as-light, color/blur elevation, focus ring #0071e3); SF Pro (Apple-proprietary, unlicensable off-platform) → Inter (SF-lineage, OFL, must be bundled). Accent kept: Apple Blue #0071e3 + #2997ff (Apple's documented link-on-dark). Section structure (§1–§15 headings + order) FROZEN from the reference.

v2 review corrections applied:
- TRANSLUCENCY (was technically false): CSS backdrop-filter cannot blur the desktop or the sibling native WebContentsView — it samples only same-document DOM layers. Win11 translucency is now stated as backgroundMaterial:'mica' only, with a transparent toolbar window region; backdrop-filter restricted to in-page popovers; honest opaque #1d1d1f fallback off Win11. (§1, §2 Material, §4 Toolbar, §6, §7, §9.)
- DEVTOOLS: docked-right is not achievable against a custom WebContentsView layout (Chromium docks to the host window). v0 = detached (openDevTools mode:'detach'); docking moved to roadmap (2nd WebContentsView + setDevToolsWebContents). (§4, §14.) **→ superseded in v3 (2026-06-17): docking *is* achievable — render devtools into a per-tab host WebContentsView via `setDevToolsWebContents` and tile it; right/bottom/detach now shipped. See the v3 intro note.**
- MOTION: removed the spring/ease self-contradiction. Chrome motion is ease only; spring is reserved for future gesture surfaces (v0 has none). Loading-bar completion is ease-standard. (§1 key char, §4, §7, §9, §15.)
- WCO: replaced hard-coded ~138px with env(titlebar-area-*) + geometrychange (DPI/maximize variable); named setTitleBarOverlay for theming. (§4, §8, §9, frontmatter platform.)
- RESIZE: setBounds synchronously in main-process 'will-resize' (rAF-gating lags during the Windows modal resize loop); seam-hider opaque fill on the web-view region only (window/toolbar stays transparent for Mica — resolves the translucency↔seam coupling); overlap retained. (§5.)
- LOADING EVENTS: did-start-navigation filtered to isMainFrame && !isSameDocument (SPA/subframe spurious triggers); did-fail-load aborts the bar so it can't hang. (§4, §14, §15.)
- TOKEN HYGIENE: 14px padding snapped to 12px (on-scale); radius sm:6 realized on suggestion rows; surface-2 naming clarified (= Apple Dark Surface 4 value). (frontmatter, §4, §5.)
- TYPE: Inter must be bundled (not preinstalled on Windows); Segoe UI Variable documented as the native-Win11 tradeoff. (§3.)
- PLATFORM: BaseWindow + single WebContentsView named; deprecated BrowserView/addBrowserView explicitly disallowed. (§5, frontmatter platform.)

Voice / Principles / Narrative (§10–§13): written from the user's project brief, NOT a corporate history. Pane is pre-release; founding date / company / public tagline intentionally omitted, not fabricated (see §11 limitation note). HIG Clarity/Deference/Depth and Liquid Glass cited as genuine stated influences (user asked for "Apple sensibility"); principle copy traces to the apple reference §11–§12. Arc/Zen named as stated influences (user brief). §13 personas are fictional archetypes of the target segment.
-->
