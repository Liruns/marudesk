# DevTools Feature Set & CDP Implementation Research

Research for porting features into marudesk's custom CDP-based DevTools (Electron
`webContents.debugger`), which already has minimal Elements, Console, and Network
panels on raw CDP + React. All mappings target the **raw protocol**, not
chrome-devtools-frontend.

## A. Panel-by-panel feature inventory (abridged to what we will port)

### Elements / Inspector
- DOM tree (lazy expand, live updates) — DONE
- Inline edit attributes/text — DONE (attr dblclick). Add: Edit as HTML (`DOM.getOuterHTML`/`setOuterHTML`), delete node (`DOM.removeNode`), duplicate, hide (toggle `visibility`)
- Force pseudo-states `:hover/:active/:focus/:focus-within/:focus-visible/:target/:visited` (`CSS.forcePseudoState`)
- DOM search by string/selector/XPath (`DOM.performSearch`/`getSearchResults`)
- Breadcrumb ancestor trail
- Computed pane (`CSS.getComputedStyleForNode`) — partially there; add filter + "show all" + grouping
- Box-model diagram (`DOM.getBoxModel`)
- Event Listeners pane (`DOM.resolveNode`→`DOMDebugger.getEventListeners`)
- Accessibility pane (`Accessibility.getPartialAXTree`/`getFullAXTree`) + contrast (`CSS.getBackgroundColors`)
- Class toggler (.cls), add declaration/rule (`CSS.addRule`), toggle declaration (comment out via `setStyleTexts`)
- Color picker / contrast (Firefox-style), Fonts pane (`CSS.getPlatformFontsForNode`)
- Grid/Flex overlays (`Overlay.setShowGridOverlays`/`setShowFlexOverlays`)

### Console
- `console.*` stream + object inspection — DONE. Add: level filter (verbose/info/warn/error), text filter, preserve-log toggle, group, timestamps toggle
- REPL eval + Command Line API — DONE. Add: autocomplete (`Runtime.globalLexicalScopeNames`/`getProperties`)
- `Log.entryAdded` (browser/CSP/network) surfaced alongside `consoleAPICalled` — DONE

### Sources / Debugger
- Breakpoints (`Debugger.setBreakpointByUrl`), step controls (`paused`/`resume`/`stepOver/Into/Out`), call stack + scopes (`paused.callFrames`+`Runtime.getProperties`), `evaluateOnCallFrame`, exception bp (`setPauseOnExceptions`), ignore-list (`setBlackboxPatterns`)
- DOM/XHR/event-listener breakpoints (`DOMDebugger.*`)
- Source view (`Debugger.scriptParsed`+`getScriptSource`), pretty-print (client), source maps (client)

### Network
- Request table — DONE. Add detail tabs: Headers (request/response/raw), Payload (`getRequestPostData`), Preview, Response (`getResponseBody`), Timing (waterfall phases), Initiator (call stack), Cookies
- WebSocket frames (`webSocketFrame*`), SSE (`eventSourceMessageReceived`)
- Throttling (`Network.emulateNetworkConditions`), Disable cache (`setCacheDisabled`), block URLs (`setBlockedURLs`)
- Filter by type/text/property; Copy as cURL/fetch (client), HAR export (client)

### Application / Storage
- localStorage/sessionStorage (`DOMStorage.*`) — easiest first
- Cookies (`Network.getCookies/setCookie/deleteCookies`)
- Cache Storage (`CacheStorage.*`), IndexedDB (`IndexedDB.*`), quota (`Storage.getUsageAndQuota`)
- Manifest (`Page.getAppManifest`), Frames (`Page.getFrameTree`), Service Workers (`ServiceWorker.*`), clear site data (`Storage.clearDataForOrigin`)

### Rendering / Emulation (cheap, high-wow toggles)
- `Overlay.setShowPaintRects/setShowLayoutShiftRegions/setShowDebugBorders/setShowFPSCounter/setShowWebVitals/setShowScrollBottleneckRects`
- `Emulation.setEmulatedMedia` (prefers-color-scheme/reduced-motion/print/forced-colors), `setEmulatedVisionDeficiency`, `setAutoDarkModeOverride`
- Device mode (`Emulation.setDeviceMetricsOverride/setUserAgentOverride/setTouchEmulationEnabled`)

### Heavy (visualization cost; defer / partial)
- Performance flame chart (`Tracing.*`/`Profiler.*`) — protocol easy, viz hard. Start with CPU profile only.
- Memory heap snapshot (`HeapProfiler.takeHeapSnapshot`) — heavy parse; start with allocation sampling.
- Layers 3D (`LayerTree.*`), Lighthouse (shell out, don't port), Recorder (custom engine).

## C. Firefox-unique features worth stealing
- Flexbox item-sizing diagram; grid per-color/line-numbers polish
- Dedicated Fonts panel with variable-font axis sliders (`CSS.getPlatformFontsForNode`+`setStyleTexts` `font-variation-settings`)
- Changes panel as first-class tab (client-side stylesheet diff) with Copy-all-changes
- Accessibility audits (contrast/labels) + tabbing-order overlay + color-blindness sim
- Inline CSS-compat hints (`@mdn/browser-compat-data`)
- Network edit-and-resend (vs Chrome's replay-only)
- Inactive-CSS tooltips ("why no effect")
- Eyedropper + full-page/node screenshot as top-level tools
- Measuring tool / rulers (`Overlay.setShowRulers`)

## D. Prioritized roadmap (given existing Elements/Console/Network)
- **P1 (high value, low effort, pure CDP):** styles editing polish + force pseudo-states; inspect-pick + hover highlight (DONE); box model + computed pane; console object expansion + autocomplete + filtering; network detail tabs (headers/body/timing/initiator) + WS/SSE; network conveniences (throttle/disable-cache/block/copy-as); rendering overlays + media/vision emulation; grid/flex overlays.
- **P2 (medium effort):** JS Debugger core + DOMDebugger breakpoints; event listeners pane; accessibility pane + audit; DOM editing (`setOuterHTML`); Storage panel (DOMStorage→cookies→cache→IndexedDB); Fonts panel; Changes tracking; Coverage; pretty-print + source maps; Manifest/Frames/SW.
- **P3:** animations; network override (`Fetch.*`, opt-in); edit-and-resend; security; issues; live-edit; sensors/webauthn.
- **P3 heavy:** Perf flame chart; Memory snapshots; Layers; Lighthouse(shell-out); Recorder.

## E. CDP gotchas (must respect)
- Domains only emit AFTER `enable`; enable at session start, not lazily, or miss early events. `DOM.getDocument` seeds the node map; `Network.enable` must precede navigation for the doc request.
- `DOM.documentUpdated` invalidates ALL `nodeId`s — discard map + re-`getDocument`; prefer `backendNodeId` for round-trips.
- `Debugger.paused` FREEZES the page until `resume`; always resume on detach/panel-close; default `setPauseOnExceptions:'uncaught'` + blackbox.
- `Fetch` interception pauses EVERY matching request — each MUST be answered or page stalls; scope patterns tightly, disable on teardown. Footgun.
- `Tracing` → tens of MB; use `transferMode:'ReturnAsStream'`+`IO.read`. `HeapProfiler` snapshots → hundreds of MB; prefer sampling.
- `Runtime` objectGroups leak page memory; use `objectGroup` + `releaseObjectGroup` on console clear/panel close.
- Network `*ExtraInfo` events arrive out of order — correlate by `requestId`. `getResponseBody` only while body retained — fetch on `loadingFinished`.
- Source maps are client's problem (fetch+decode VLQ+map both ways).
- Workers/SW/OOPIF are separate targets (`Target.setAutoAttach`/`attachToTarget`, flatten sessions).
- Overlay state is sticky — reset on panel close/detach. `setInspectMode` keeps intercepting until off.
- Several domains experimental in /tot/; pin to Electron's Chromium and re-verify after upgrade.

Reference: https://chromedevtools.github.io/devtools-protocol/tot/{DOM,CSS,Overlay,Runtime,Debugger,DOMDebugger,Network,Fetch,Page,Storage,DOMStorage,IndexedDB,CacheStorage,Profiler,HeapProfiler,Tracing,Accessibility,Security,Audits,Animation,Emulation,ServiceWorker,LayerTree}/
