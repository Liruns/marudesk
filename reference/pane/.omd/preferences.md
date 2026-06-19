---
schema: omd.preferences/v1
design_md_hash_at_creation:
---

# Preference Log

## 2026-06-16T09:24:44.505Z — introduced-off-scale-border-radius-borde

```omd-meta
id: pref_mqgfrg49_820a3b1e
timestamp: 2026-06-16T09:24:44.505Z
scope: visualTheme
signal: ambient
confidence: inferred
status: pending
source_agent: claude-code
source_context: "C:\\toy\\src\\internal\\downloads\\downloads.css"
```

Introduced off-scale border radius border-radius:10px in C:/toy/src/internal/downloads/downloads.css — not in DESIGN.md radius scale

## 2026-06-16T12:00:00.000Z — address-bar-left-anchored-not-centered

```omd-meta
id: pref_addrbar_leftanchor
timestamp: 2026-06-16T12:00:00.000Z
scope: layout
signal: explicit
confidence: stated
status: applied
source_agent: claude-code
source_context: "user feedback on screenshots: '검색뜨는거 위치도 별로', chose left-aligned+fill"
```

User reviewed live screenshots and disliked the center-floated address pill (large dead gaps each side; the suggestion dropdown floated mid-screen). Decision: address pill is **left-anchored** (after the nav cluster) and **fills toward the right cluster**, `width:100%; max-width:1080px`. Suggestion dropdown follows the pill's left edge. The new-tab/start-page pill stays centered (separate surface). Applied to DESIGN.md §4 and code (toolbar.css `.address-wrap` justify-content:flex-start; address-bar.css `.address-pill` max-width:1080px).
