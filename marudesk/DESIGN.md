---
id: marudesk
name: marudesk
category: developer-tools
homepage: ""
primary_color: "#C75A3B"
omd: "0.1"
ds:
  name: Maru Design System
  type: brand
  description: Dark-first design system for Maru, a runtime-aware AI IDE. Graphite & Minium default (a warm-neutral matte graphite with a single disciplined minium accent, no decorative glow), Raycast/Warp secondary, with Cursor AI Timeline 4-color accent. The cooler classic near-black stays selectable as Carbon.
---

# Maru Design System

> Single source of truth: `src/styles/tokens.css`. **Never hard-code colors, radii, or fonts in components.** Reference CSS variables or Tailwind aliases that map to them.

## 1. Visual Theme & Atmosphere

marudesk is a tool you live inside for 8 hours a day. The atmosphere is **dark-first, precise, and unhurried**, in the lineage of Linear and Raycast. The default theme is **Graphite & Minium**: the page canvas (`#121211`) is a warm-neutral matte near-black — paper-and-graphite with a faint warm-grey bias and *no* blue/purple chroma, so it reads hand-crafted rather than like a tinted "AI" canvas — sitting intentionally deeper than the surrounding panel surfaces (`#1A1A18`, `#222220`). Depth comes from the monotonic surface ramp and hairline borders alone: **there is no decorative glow, bloom, or halo anywhere** — those read as AI-generated. The cooler classic near-black stays one click away as the **Carbon** palette. The screen is calm so the user's work (their browser, their code, their AI conversation) can carry the visual weight.

Typography is Inter for UI and JetBrains Mono for code. Inter Display takes over only at hero sizes. Numerals are always tabular — `3 files`, `12ms`, `line 47` should never re-flow as values change. The single brand accent is **minium** (`#C75A3B`) — a desaturated lead-oxide orange-red used *sparingly* (active state, focus ring, cursor, one primary action); a designer's spot color that harmonizes with the warm graphite rather than "popping" like a brand gradient. Crimson appears only as the error state, never as default chrome.

The product has three foreground voices it must keep separate:
- **The user's browser stage** (the website being inspected) — chrome stays minimal so we don't visually fight a Stripe page or a Notion page.
- **marudesk's own UI** — a quiet dark frame around the stage.
- **AI activity** — surfaced through the 4-color AI Timeline (`thinking/grep/read/edit`), the only place where chromatic color enters the interface.

**Key characteristics**

- Surface scale of four steps from `#121211` (page) to `#2C2B29` (input/hover), each carrying the same faint warm-grey undertone so the lift reads as one material catching more light. No surface change exceeds one step in a single layout.
- The form language is **crisp and dense** (IDE-tight): controls and surfaces pack close, corners read sharp. 4px is the default border radius. 3px for small elements, 6px for large, full-pill (9999px) only for status dots and true pills. Tailwind's `rounded-md`/`-xl` ride these tokens too, so the whole radius scale sharpens from `tokens.css` alone.
- Borders are white at 6 / 10 / 16% alpha — they read as hairlines, not as enclosing shapes.
- Motion is fast and short. 120ms for hover, 200ms for panels. Easing is a single cubic-bezier(0.2, 0, 0, 1).
- No emojis. No decorative iconography. No exclamation marks in product copy.

## 2. Color Palette & Roles

### Surface
| Token | Value | Use |
|---|---|---|
| `--surface-page` | `#121211` | Page background, deepest. The default canvas (warm-neutral matte graphite). |
| `--surface-1` | `#1A1A18` | Panels, drawers — one step lifted from page. |
| `--surface-2` | `#222220` | Cards, elevated containers. |
| `--surface-3` | `#2C2B29` | Inputs, hover states, code blocks. |

### Text
| Token | Value | Use |
|---|---|---|
| `--text-primary` | `#F4F3F0` | Body, headings, anything the user reads first (~16:1 on page). |
| `--text-secondary` | `#B0AEA8` | Descriptions, metadata, secondary labels (~8.5:1). |
| `--text-tertiary` | `#7E7C75` | Placeholders, helper text, low-emphasis (~4.2:1). |
| `--text-quaternary` | `#6A6862` | The lowest *readable* tier — genuinely low-emphasis functional copy (empty-state hints, "no acceptance criteria"), at the ~3:1 floor for large/UI text. Reach for this token instead of stacking an opacity modifier (`/70`, `/60`) on `--text-tertiary`, which pushes copy below the AA boundary. |
| `--text-disabled` | `#56544E` | Disabled controls only — sits below quaternary and is **not** for readable copy. |

### Border
| Token | Value | Use |
|---|---|---|
| `--border-subtle` | `rgba(255,255,255,0.06)` | Section dividers, card outlines. |
| `--border-default` | `rgba(255,255,255,0.10)` | Inputs, buttons, default container edge. |
| `--border-strong` | `rgba(255,255,255,0.16)` | Active/focused borders, emphasized rules. |

### Accent — single voice
| Token | Value | Use |
|---|---|---|
| `--accent` | `#C75A3B` | Active state, focus, cursor, one primary action (minium — used sparingly). |
| `--accent-hover` | `#D86A49` | CTA / hover. |
| `--accent-subtle` | `rgba(199,90,59,0.13)` | Accent fill for active rows, selection. |

There is exactly one accent. Do not introduce a second hue for "secondary brand."

### Semantic
| Token | Value | Use |
|---|---|---|
| `--success` | `#4CB782` | Patch applied, save confirmation, healthy status. |
| `--warning` | `#F2C94C` | Low-confidence match, non-blocking caution. |
| `--error` | `#EB5757` | Validation failure, model error, destructive confirm. |

### DevTools box model — diagram fills only
The Elements panel's box-model diagram uses four region fills that mirror
Chromium's inspector-overlay hues at low alpha, so the in-panel diagram matches
the on-page highlight. Like the AI Timeline colors, they are **never** ordinary
UI color — they exist only for the box-model diagram.

| Token | Value | Region |
|---|---|---|
| `--boxmodel-margin` | `rgba(246,178,107,0.25)` | Margin ring |
| `--boxmodel-border` | `rgba(255,229,153,0.30)` | Border ring |
| `--boxmodel-padding` | `rgba(147,196,125,0.30)` | Padding ring |
| `--boxmodel-content` | `rgba(111,168,220,0.30)` | Content box |

### AI Timeline — chromatic only here
The 4-color accent system, alpha-adjusted (0.72) for dark surfaces. Each color maps to a specific AI operation type.

| Token | Value | Operation |
|---|---|---|
| `--ai-thinking` | `rgba(223,168,143,0.72)` (peach) | Model is composing |
| `--ai-grep` | `rgba(159,201,162,0.72)` (sage) | Search/grep over workspace |
| `--ai-read` | `rgba(159,187,224,0.72)` (blue) | Reading source files |
| `--ai-edit` | `rgba(192,168,221,0.72)` (lavender) | Generating/applying edits |

These four are **never** used as ordinary UI color. They appear in the AI Timeline visualization and the model-state Spinner. Promoting any of them to default chrome breaks the visual contract.

## 3. Typography Rules

### Font family
| Role | Family | Fallbacks |
|---|---|---|
| Display | `Inter Display` | `Inter`, `system-ui`, `-apple-system`, `Segoe UI`, sans-serif |
| Body / UI | `Inter` | `system-ui`, `-apple-system`, `Segoe UI`, sans-serif |
| Mono / Code | `JetBrains Mono` | `ui-monospace`, `SF Mono`, Menlo, Consolas, monospace |

Embed the fonts locally via `@fontsource/inter` and `@fontsource/jetbrains-mono` packages when shipping for offline-first behavior (CSP does not permit Google Fonts). Until embedded, system fallbacks render acceptably.

### Hierarchy

| Role | Size | Weight | Line height | Tracking |
|---|---|---|---|---|
| Hero | 40px | 600 | 1.12 | -0.5px |
| Section heading | 24px | 600 | 1.20 | -0.2px |
| Title | 18px | 600 | 1.30 | -0.1px |
| Body | 14px | 400 | 1.55 | 0 |
| Body small | 13px | 400 | 1.45 | 0 |
| Caption | 12px | 500 | 1.40 | 0.1px |
| Mono body | 13px | 400 | 1.55 | 0 |
| Mono small | 12px | 400 | 1.45 | 0 |

### Principles
- **Numerals are tabular.** All numeric content uses `font-variant-numeric: tabular-nums` via the `.tabular` class or by default. This is non-negotiable for status displays (`12ms`, `3 files`, line numbers).
- **Weight does most of the work.** 400 / 500 / 600 are the only weights you should reach for. Skip 700 unless rendering a brand mark.
- **Tracking tightens with size, never loosens.** Hero 40px gets -0.5px. Body 14px gets 0. Caption 12px gets +0.1px.
- **No italics in UI.** Italics survive in code only (e.g. JSDoc comments, syntax highlight).

## 4. Component Stylings

### Button
- Radius: 4px (`--radius`)
- Heights: 24px (sm), 28px (md/default), 32px (lg). Horizontal padding 10/12/14px — one step tighter than a comfortable control so toolbars pack more per row.
- Icon/label gap: 6px.
- Font: 13–14px Inter, weight 500
- Primary: `bg-accent` + `text-white`, hover `bg-accent-hover`
- Secondary: `bg-surface-2` + `text-fg-primary`, 1px `border-default`, hover `bg-surface-3`
- Ghost: transparent + `text-fg-secondary`, hover `text-fg-primary` + subtle `bg-surface-2`
- Focus: 2px outline using `--accent`, 2px offset
- Disabled: 0.5 opacity, no hover, `cursor-not-allowed`

### Surface
- Generic panel/container wrapper
- Background: `--surface-1` default; `--surface-2` for elevated variant
- Border: 1px `--border-subtle` default; `--border-default` for emphasis
- Radius: 4px default; 6px for large featured surfaces

### Drawer
- Right or bottom anchored
- Background: `--surface-1`
- Width: 380px (right drawer default); 60vh max (bottom drawer)
- Border: 1px `--border-subtle` on the side facing the stage
- Motion: 200ms `cubic-bezier(0.2, 0, 0, 1)` for both open and close
- Backdrop: none (drawers coexist with the stage, never veil it)

### DiffBlock
- File path header: 13px Inter mono row, `--text-secondary`, `--surface-2` background, `--border-subtle` bottom edge
- Body: 13px JetBrains Mono
- Add lines: `rgba(76,183,130,0.10)` background, `--success` left-bar 2px
- Remove lines: `rgba(235,87,87,0.10)` background, `--error` left-bar 2px
- Context lines: no background
- Line numbers: `--text-tertiary`, mono, right-aligned in 40px gutter

### Spinner (model state)
- 16px square, four arcs rotating
- Each arc colored from one of `--ai-thinking / --ai-grep / --ai-read / --ai-edit`
- Cycle: 1.2s linear rotation
- When idle, hidden — never a placeholder shimmer

### Badge
- Small-radius (3px, `--radius-sm`) rectangle — crisp/dense, not a full pill. (Pill-round is reserved for status *dots* and true tags.)
- Padding: 0 6px
- Font: 11–12px Inter, weight 500
- Variants:
  - `neutral`: `--surface-3` bg, `--text-secondary` text
  - `accent`: `--accent-subtle` bg, `--accent` text
  - `success`: `rgba(76,183,130,0.12)` bg, `--success` text
  - `warning`: `rgba(242,201,76,0.12)` bg, `--warning` text
  - `error`: `rgba(235,87,87,0.12)` bg, `--error` text

### Toast
- Bottom-right anchored, 16px from edges, 8px between stacked toasts
- Background: `--surface-2`
- Border: 1px `--border-default`
- Radius: 4px
- Padding: 10px 12px
- Width: min(340px, 90vw)
- Enter: 200ms translate-y + opacity; Exit: 120ms opacity
- Auto-dismiss: 4500ms default (10000ms for error), pause on hover
- Title 13px weight 500, body 12px weight 400 `--text-secondary`

## 5. Layout Principles

### Spacing
- Base unit: 8px
- Scale: 4, 8, 12, 16, 24, 32, 48 (px). Map directly to Tailwind's default 1/2/3/4/6/8/12.
- **Dense by default.** The form language is information-dense: control padding, row height, and gaps sit one step tighter than a comfortable layout (e.g. list rows at 6–8px vertical, card padding 10–12px, toolbar gaps 6px). Reach for the tighter rung first; spend the larger gaps (24–32px) only to separate *major* sections.
- Sub-8px spacing (2, 3, 5, 6) is fair game for component-internal padding and tight rows here, not just icon-text alignment.

### Grid
Mission Control is a three-band vertical stack (`Shell.tsx`): a slim title/flight bar, the main row, and the Evidence strip. The main row is the dominant zone — it is full-bleed and carries the visual weight.

- **Title/Flight bar (top): 36px tall** (`h-9`, `TitleBar.tsx`). Brand mark, flight status, window controls; `min-w-0` so the center content truncates rather than pushing the window controls. Not a 40px bar.
- **Instrument rail (left of the main row): 60px** (`InstrumentRail.tsx`). An always-visible launcher for the staple tools (browser, editor, terminal, Source Control, files, search, chat + Settings) — each button summons the same full-area instrument as its ⌘K command. The active instrument's entry lights up. It lines up under the 60px title-bar logo column so the top-left reads as one continuous vertical rail.
- **Main row (`flex-1`):** the home is the **Task graph**, rendered full-area via `WorkGraphStage`. When a task summons a tool, an `InstrumentStage` replaces the graph in the same full-area slot (tools are instruments a task summons, never persistent windows). The stage owns all horizontal space the rail and dock do not.
- **Instrument Dock (right of the main row): 22.5rem when open, 0 when closed** (`InstrumentDock.tsx`). It is the per-task inspector + chat, opening only when a task node is selected; it animates its width on the motion-standard token. Width is clamped to `calc(100vw - 60px - 3rem)` — reserving the rail and keeping the stage ≥3rem — so it never eats the whole row on a narrow window. It is hairline-bordered on the edge facing the stage. There is **no** right drawer and no agent-chat drawer — the former `ContextDrawer` was retired and agent chat moved into this dock.
- **Evidence strip (bottom): 24px tall** (`h-6`, `EvidenceStrip.tsx`). This is the selected task's acceptance verdicts (verdict dots + title), system-filled by the apply-time checker — not a generic status bar, and not live CDP "runtime evidence" (that term is the DevTools timeline's).
- No fixed max width — marudesk fills the application window.

### Whitespace
- Dark backgrounds make negative space feel quiet, not empty. Use generous gaps (24–32px between major sections, 16px between cards) without fear of looking sparse.
- Avoid section dividers (`<hr>`). Use background tone shift (`--surface-1` → `--surface-2`) for separation.

## 6. Depth & Elevation

| Level | Treatment | Use |
|---|---|---|
| Flat | No shadow, no border | Body text, inline content |
| Hairline (L1) | 1px `--border-subtle` | Default container outline |
| Hairline strong (L1b) | 1px `--border-default` | Inputs, buttons |
| Top-edge catch | `--highlight` (`shadow-highlight`) | Flush panels, launcher tiles, chips — a 1px inset highlight on the top edge |
| Carved inset | `--inset-shadow` (`shadow-inset-soft`) | Recessed `inset` surfaces (code wells, inputs) — soft inner shadow |
| Card | `--elevate-card` (`shadow-card`) | Elevated cards — stronger top highlight + soft drop |
| Soft glow (L2) | `0 0 0 1px var(--border-default), 0 8px 24px rgba(0,0,0,0.32)` | Drawer leading edge, popover |
| Lifted (L3) | `0 0 0 1px var(--border-default), 0 24px 56px rgba(0,0,0,0.48)` | Modal, command palette, picker |
| Focus ring | `0 0 0 2px var(--surface-page), 0 0 0 4px var(--accent)` | Keyboard focus on interactive elements |

**Depth fills (layered, not surfaces).** The surface scale is intentionally tight (~9% across four steps), so pure fills can read flat. Two background-image tokens add volume *over* a surface fill — the surface token still owns the base color:

| Token | Tailwind | Use |
|---|---|---|
| `--surface-gradient` | `bg-surface-gradient` | Featured cards/tiles — a ~2.5% top→bottom lift fading by ~64% |
| `--page-vignette` | `bg-vignette` | `none` — there is no decorative page bloom (a glow reads as AI-generated); depth comes from the surface ramp + hairline borders instead. |

The leaf values (`--highlight-top`, `--highlight-top-strong`, the gradient and vignette stops) flip under `data-theme="light"` so depth reads correctly in both modes; the structural tokens above reference them.

**Philosophy.** Elevation on dark surfaces comes from borders first, shadows second. A diffuse, large-radius shadow (24px+) reads as light bending around a panel; a tight shadow reads as a sticker pasted onto the screen. Avoid the latter. The top-edge catch and surface gradient are the quiet third instrument: they suggest light hitting an upper lip rather than a panel floating, so they layer *beneath* the border and never replace it.

## 7. Do's and Don'ts

- **DO** consume CSS variables (`var(--surface-1)`) or Tailwind aliases (`bg-surface-1`) in every component.
- **DON'T** write `bg-[#1A1B1F]` or any literal hex inside JSX. The token layer must remain the only place colors live.
- **DO** keep the AI Timeline 4 colors restricted to AI-state surfaces (Spinner, Timeline, model badges).
- **DON'T** repurpose `--ai-thinking` as a generic warm accent. The semantic mapping is the contract.
- **DO** prefer borders over shadows for elevation cues on dark surfaces.
- **DON'T** stack two filled surfaces of the same tone. If two containers need to touch, one must be one step lighter than the other.
- **DO** use tabular numerals for every numeric display.
- **DON'T** use exclamation marks in product copy. "Patch applied to 3 files." not "Patch applied!"
- **DO** keep loading states quiet. Spinner only — no shimmer skeletons, no bouncing dots.
- **DON'T** introduce a second accent hue under any framing ("just for this CTA", "secondary brand"). One accent.

## 8. Responsive Behavior

marudesk is a desktop application; the responsive surface is narrow. There is no breakpoint-driven layout switch — the chrome holds its shape and degrades by clamping and truncation rather than collapsing panels.

| Surface | Behavior under width pressure |
|---|---|
| Title/Flight bar | The center content is `min-w-0` and truncates; the brand mark and window controls stay fixed, so the bar never wraps. |
| Instrument rail | Fixed 60px, `shrink-0` — it never collapses; it is the always-present left edge the dock clamp and stage are measured against. |
| Instrument Dock | Fixed at 22.5rem when a task is selected, but clamped to `maxWidth: calc(100vw - 60px - 3rem)` — reserving the rail — so on a narrow window it yields and the main row always keeps ≥3rem. Closed (no task selected) it is 0-width and the stage takes the row minus the rail. |
| Main row (stage) | Always `flex-1 min-w-0`; absorbs whatever the rail and dock leave. The Task graph pans/zooms within it rather than reflowing. |
| Evidence strip | Single 24px row; the task title truncates and the verdict dots cap at 12 with an overflow count. |
| Transcripts (dock chat / instruments) | Long histories window rather than growing the layout. |

The renderer is sized by Electron; we do not target browser-tab embedding.

## 9. Motion & Easing

| Token | Value | Use |
|---|---|---|
| `--motion-instant` | 0ms | Cursor commits, focus state changes |
| `--motion-fast` | 120ms | Hover color/opacity transitions |
| `--motion-standard` | 200ms | Panel slides, drawer open/close, modal enter |
| `--easing` | `cubic-bezier(0.2, 0, 0, 1)` | Default for every transition |

### Entrance keyframes

Two short, single-easing entrances give the UI character without breaking the "one cubic-bezier, no overshoot" rule. Both ride the motion tokens.

| Animation | Tailwind | Use |
|---|---|---|
| `fade-rise` | `animate-fade-rise` | First-paint surfaces — opacity + 8px rise. Stagger siblings with `[animation-delay:Nms]` (Home cascades the brand, field, launcher, recents, hint at 0/60/120/180/240ms). |
| `scale-in` | `animate-scale-in` | Modal / picker open — a 0.98→1 settle (QuickOpen, ModelPalette, DiffViewer). |

Press feedback is a 1px settle, not a bounce: interactive tiles drop their hover lift and ease to `scale-[0.99]` on `:active`.

`prefers-reduced-motion: reduce` disables slide transitions and Spinner rotation (Spinner becomes a static dot), and collapses these entrances (duration **and** delay) to a near-instant snap.

## 10. Voice & Tone

**Precise, unhurried, builder-to-builder.** marudesk talks like a senior teammate writing a Slack DM, not like a marketing site.

| Context | Tone |
|---|---|
| CTA | Plain verb. "Apply patch", "Capture element", "Open workspace". |
| Status | Sentence with a period. "Patch applied to 3 files. Review the diff." |
| Error | Specific. "Path is outside workspace. Edit rejected." Never "Oops" / "Something went wrong". |
| Confirmation | Past tense, no celebration. "Workspace opened." |
| Empty state | Direct instruction. "Open a folder to start." |

**Numbers are mono.** `3 files`, `12ms`, `line 47`. Always tabular nums.

**Forbidden.** Exclamation marks. "Successfully". "Awesome". "Get Started" (use "Open workspace"). "Click here" (use the action verb). "AI-powered" (use the specific mechanic). Emojis.

## 11. Iconography

- One library: Lucide React (1,400+ icons, stroke 2, fits the rest of the system).
- Sizes: 14px (inline text), 16px (button leading), 20px (drawer/section), 24px (empty state).
- Color: always `currentColor`. Never hard-code stroke/fill.
- Custom icons (logo, marudesk mark): export as React SVG components with `currentColor`.

## 12. Document Policies

- **No emojis** anywhere in UI, labels, status, or docs. Status indicators are colored dots or icons.
- **No hard-coded colors** in components. Tokens or Tailwind aliases only.
- **No literal hex values in commit messages** describing styles (use the token name).
- Update this DESIGN.md when introducing a new token. The doc and `tokens.css` move together.

---

**Verified:** 2026-05-28 (Phase 0 handoff); default theme switched to **Graphite & Minium** 2026-06-21 (no decorative glow; the cooler classic near-black preserved as the Carbon palette).
**Source of truth for values:** `src/styles/tokens.css`
**Tailwind theme alias map:** `tailwind.config.ts`
