# Pane

A small, beautiful browser developers want to use every day. **The chrome is the product.**

> Design system: see [`DESIGN.md`](DESIGN.md) — dark, Apple-inspired, one accent, the page
> is the hero. Stack is locked: Electron, native `WebContentsView`s, no Chromium/Firefox fork.

## Run

```bash
npm install      # installs Electron
npm start        # launches Pane
```

No build step — the main process is CommonJS, the renderer and internal pages are native ES
modules / scripts loaded straight from disk.

## Architecture

- **Electron `BaseWindow`** hosts native `WebContentsView`s (DESIGN.md §5):
  - a **chrome view** — the HTML/CSS/JS toolbar + tab strip (`src/renderer/`),
  - one **page view per tab** (`src/main/page-view.js`), repositioned with `setBounds`
    synchronously on `will-resize` so the page never lags the chrome (resize integrity is P0).
- **Frameless** window with **native** window buttons via Windows Controls Overlay.
- Toolbar ⇄ main over **preload/IPC** — two lanes:
  - `window.pane` (`src/preload/index.js`) for the toolbar,
  - `window.paneInternal` (`src/preload/page.js`) exposed **only** to `pane://` pages; every
    handler re-checks the sender origin.
- **Internal pages ride a `pane://` protocol rail** (`src/main/protocol.js`): new-tab, error,
  history, settings, bookmarks, downloads are real origins (addressable, back/forward,
  bookmarkable). A new screen is one route + one HTML file.
- **Mica is intentionally not used.** `backgroundMaterial: 'mica'` + `titleBarOverlay` renders
  black and breaks on maximize (electron #42393 / #39959 / #41824); the brief locks native
  window buttons, so the toolbar ships an honest opaque dark instead.

```
src/
  main/                  # Electron main (Node, CommonJS)
    index.js             # app lifecycle + window bootstrap
    pane-window.js       # window shell: BaseWindow + view layout/resize + active-tab swap + bridge
    tab-manager.js       # owns the tabs (one PageView each) + which is active
    page-view.js         # PageView controller (nav + events) — one per tab
    chrome-view.js       # ChromeView controller (the toolbar view)
    protocol.js          # the pane:// rail — serves src/internal/* and pane://assets/*
    ipc.js               # window.pane handlers → active tab / window
    internal-ipc.js      # window.paneInternal handlers (history/settings/bookmarks/downloads)
    shortcuts.js         # before-input-event keymap (per tab + chrome)
    history.js           # visit log (timestamps) → autocomplete + history page
    bookmarks.js         # bookmark list
    downloads.js         # will-download tracking + actions
    settings.js          # persisted settings
    session.js           # tab/window session restore
    store.js             # tiny JSON persistence (userData)
    nav-history.js       # canGoBack/forward helpers
  preload/
    index.js             # window.pane bridge (toolbar)
    page.js              # window.paneInternal bridge (pane:// pages only)
  renderer/              # the chrome UI (native ES modules, no bundler)
    index.html
    main.js              # entry — wires the feature modules
    features/            # tabs · address-bar · url-parser · suggestions · navigation ·
                         #   loading-bar · window-controls · menu · find · toast
    lib/                 # dom ($ / on) · overlay (chrome-grow coordinator)
    styles/              # index.css → tokens · base · toolbar · tabs · address-bar · … · toast
  internal/              # pane:// pages (own CSP, scoped paneInternal)
    newtab · error · history · settings · bookmarks · downloads
  shared/                # cross-process (CommonJS)
    channels.js          # IPC channel names
    config.js            # window sizes, chrome/toolbar heights, colors
```

## Features (v0)

A focused daily driver — everything below is hand-built chrome, no accounts, no fork:

- **Tabs** — `TabManager`, favicons, `Ctrl+Tab` cycling, double-click-to-maximize,
  **drag-to-reorder**, a **right-click menu** (reload / duplicate / close / close others),
  and **reopen-closed** (`Ctrl+Shift+T`).
- **Smart address bar** — scheme / `localhost` / IPv4 / IPv6 / IDN / Windows-path → load, else
  search; real-host decisions use the **Public Suffix List** (`lib/host.js`, backed by a vendored
  [`tldts`](https://github.com/remusao/tldts) bundle) plus a package denylist (`socket.io`,
  `node.js`…); with a Go-to / Search **suggestion dropdown** and **history autocomplete**.
- **Navigation** — back / forward / reload↔stop, a trickle **loading bar** that aborts on failure.
- **In-page context menu** — a native right-click menu, contextual to what you clicked: open a link or
  image in a background tab, copy / save it, copy or **search** a selection, spellcheck fixes in
  editable fields, page back / forward / reload, and **Inspect Element** (routed into Pane's own
  dockable devtools, never Chromium's docked window).
- **`pane://` internal pages** — new-tab start page, custom error page, and:
  - **History** (`Ctrl+H`) — per-visit log grouped by day, search, per-row delete.
  - **Bookmarks** (`Ctrl+D` to toggle) — flat list, search, delete; a quiet toast confirms.
  - **Downloads** (`Ctrl+J`) — auto-save to the OS Downloads folder, live progress, open /
    show-in-folder.
  - **Settings** (`Ctrl+,`) — restore-session toggle, clear history. The ⋮ menu is a launcher.
- **Find in page** (`Ctrl+F`), per-tab **zoom** (`Ctrl±` / `Ctrl+0`), dockable **devtools**
  (`Ctrl+Shift+I`; right-click the button to dock right / bottom / detach — resizable, remembered).
- **Session restore** — reopen tabs + window bounds on launch.
- **Keyboard a11y** — arrow-key navigation in the tab strip and the ⋮ / right-click menus,
  with `2px` accent focus rings (DESIGN §6).
- Native window controls + window drag, **resize integrity**, bundled **Inter** font.

### Keyboard

| | | | |
|---|---|---|---|
| `Ctrl+L` Focus address | `Ctrl+T` New tab | `Ctrl+W` Close tab | `Ctrl+Tab` Cycle tabs |
| `Ctrl+R` Reload | `Ctrl+F` Find | `Ctrl+=`/`-`/`0` Zoom | `Alt+←`/`→` Back/Forward |
| `Ctrl+D` Bookmark | `Ctrl+H` History | `Ctrl+J` Downloads | `Ctrl+,` Settings |
| `Ctrl+Shift+I` DevTools | `Ctrl+Shift+T` Reopen tab | | |

## Known constraints (deferred)

- **Mica** — blocked by the Electron bug above; revisit if fixed, or via a native DWM helper.

## Roadmap

Tabs ✓ → runtime/devtools depth (dockable devtools ✓) → an **infinite-canvas** mode where many
Pane instances float and arrange on one surface. The canvas future is earned by a flawless single
pane first.
