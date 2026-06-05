# Browser Menu & Settings → Embedded Dev Browser Design

Research distilled for marudesk's embedded browser (one tab kind among
terminal/editor/devtools/home). Principle: **Arc's lean model wearing Chrome's
page-action menu.** Don't re-implement window/profile/theme/default-browser/
extension concerns — the IDE shell already owns those.

## Decision: browser ⋮ menu (toolbar button) + a global Settings → Browser category

### Per-browser-tab ⋮ menu (on the browser toolbar)
Only page-scoped + dev-scoped actions:
```
Find in page…            Ctrl+F     (existing find)
Zoom  −  100%  +                    (existing zoom; inline row) + Reset (Ctrl+0)
──────────────
Reload                   Ctrl+R
Hard reload (clear cache) Ctrl+Shift+R
──────────────
History…                 Ctrl+H     (frecency history)
Downloads                Ctrl+J     (toggle existing shelf)
──────────────
Open DevTools            F12        (CDP devtools)
View page source         Ctrl+U
Copy current URL
Duplicate tab
──────────────
Print / Save as PDF…     Ctrl+P
──────────────
Browser settings…                   (deep-link → global Settings → Browser)
```
Back/forward/reload/favicon/find stay as native toolbar controls (occlusion
constraint favors native-rendered toolbar over occluded menus/dropdowns).

### Global Settings → Browser category (new; sits next to Browser DevTools)
- On new browser tab: Home / blank / specific URL
- Default search engine: dropdown (drives address-bar autocomplete)
- Default page zoom: percent
- Downloads: location, ask-where-to-save toggle, auto-open shelf toggle
- History: retention/max, Clear browsing data… (history/cache/cookies), enable frecency suggestions toggle
- Privacy (lightweight): HTTPS-only toggle, block third-party cookies, Do-Not-Track, site permissions list
- Developer: disable cache while DevTools open, default DevTools dock side (already in Browser DevTools), User-Agent override

Keep browser-chrome theming in the global **Appearance** category (inherit app look).

### Omit (bloat/wrong for embedded dev browser)
Set-as-default, Cast, Profiles/users, Sync/sign-in, Bookmarks bar/manager
(replace with history+frecency; optional Arc-style pinned URLs on home),
Extensions/Web Store, Incognito windows, New-window/tab-management in menu,
reading list/tab groups/name-window/send-to-devices/QR/translate, in-browser themes.

## Implementation checkpoint (2026-06-05)

This pass shipped the user-requested browser fixes without taking the whole
settings surface at once:

1. The browser toolbar menu is native, so opening it no longer darkens/occludes
   the embedded browser view.
2. Visit history exists and is reachable from the menu; selecting a history item
   navigates the current browser tab.
3. The embedded browser view resizes with its host tab/stage.
4. The menu keeps the already-wired page/dev actions that are safe in the current
   browser shell.

Remaining follow-up from the fuller design below: `view-source`, a dedicated
Browser settings category, new-tab behavior, default zoom, downloads auto-open
shelf, UA override, and disable-cache-with-devtools. Do NOT build
profiles/sync/extensions/bookmarks.
