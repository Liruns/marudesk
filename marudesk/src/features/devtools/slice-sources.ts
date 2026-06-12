import type { StoreApi } from 'zustand';
import { cdpTry } from './cdp';
import {
  decodeBase64Text,
  decodeSourceMapDataUrl,
  defaultSourceIndex,
  generatedPositionFor,
  originalPositionFor,
  parseSourceMap,
  resolveSourceUrl,
  resolveUrl,
  type ScriptSourceMap,
} from './source-map';
import type {
  CdpEvalResult,
  DebuggerCallFrame,
  PausedInfo,
  ScriptInfo,
  WatchResult,
} from './types';
import type { DevtoolsState, DevtoolsActions } from './store';

type DevtoolsStore = DevtoolsState & DevtoolsActions;
type SetState = StoreApi<DevtoolsStore>['setState'];
type GetState = StoreApi<DevtoolsStore>['getState'];

type SourcesActions = Pick<
  DevtoolsActions,
  | 'selectScript'
  | 'openScript'
  | 'openScriptAt'
  | 'revealBreakpoint'
  | 'revealLocation'
  | 'toggleBreakpoint'
  | 'toggleOriginalBreakpoint'
  | 'selectOriginalSource'
  | 'showCompiledSource'
  | 'setPauseOnExceptions'
  | 'pause'
  | 'resume'
  | 'stepOver'
  | 'stepInto'
  | 'stepOut'
  | 'selectCallFrame'
  | 'addXhrBreakpoint'
  | 'removeXhrBreakpoint'
  | 'toggleXhrBreakpoint'
  | 'toggleEventBreakpoint'
  | 'addWatch'
  | 'removeWatch'
  | 'refreshWatches'
  | '_ensureSourceMap'
  | '_applySources'
  | '_handlePaused'
  | '_handleResumed'
>;

/**
 * The Sources/Debugger panel actions for the devtools store: script selection +
 * source fetch, url:line breakpoints (set/remove + re-apply on re-attach),
 * pause-on-exceptions, the execution controls (resume/step*), the pause
 * machine fed by `Debugger.paused`/`Debugger.resumed` (relayed from
 * ingest-batch as effects), source-map original-source restoration (P5b),
 * DOMDebugger XHR/event-listener breakpoints, and watch expressions. Follows
 * the slice-creator pattern of its siblings.
 *
 * While the page is paused, only Debugger/Runtime commands complete — every
 * action here uses exactly those (DOMDebugger arming and source-map fetches
 * happen outside the pause path), so the panel stays responsive and other
 * slices aren't deadlocked behind the pause.
 *
 * Source maps are strictly best-effort: every mapping feature falls back to
 * the generated view silently — a missing/corrupt/unfetchable map can never
 * break the plain script path.
 */

// Source-map fetch bounds: per-IO.read chunk size and a total cap so a hostile
// or enormous .map can't balloon renderer memory (maps beyond it are skipped).
const MAP_READ_CHUNK = 1 << 20;
const MAX_MAP_CHARS = 40_000_000;

const WATCH_GROUP = 'marudesk-watch';

function isHttpUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

/**
 * Fetch a resource's text through the page's network session via CDP:
 * `Network.loadNetworkResource` (the host renderer can't fetch it directly —
 * CSP) returns an IO stream handle that is drained with `IO.read`. Best-effort:
 * null on any failure.
 */
async function fetchCdpResource(
  tabId: string,
  url: string,
  frameId: string | undefined,
): Promise<string | null> {
  let fid = frameId;
  if (!fid) {
    const tree = await cdpTry<{ frameTree?: { frame?: { id?: string } } }>(
      tabId,
      'Page.getFrameTree',
    );
    fid = tree?.frameTree?.frame?.id;
  }
  if (!fid) return null;
  const res = await cdpTry<{
    resource?: { success?: boolean; stream?: string };
  }>(tabId, 'Network.loadNetworkResource', {
    frameId: fid,
    url,
    options: { disableCache: false, includeCredentials: true },
  });
  const resource = res?.resource;
  if (!resource?.success || !resource.stream) return null;
  const handle = resource.stream;
  let text = '';
  let ok = false;
  for (;;) {
    const chunk = await cdpTry<{ data: string; base64Encoded?: boolean; eof: boolean }>(
      tabId,
      'IO.read',
      { handle, size: MAP_READ_CHUNK },
    );
    if (!chunk) break;
    const piece = chunk.base64Encoded ? decodeBase64Text(chunk.data) : chunk.data;
    if (piece === null) break;
    text += piece;
    if (chunk.eof) {
      ok = true;
      break;
    }
    if (text.length > MAX_MAP_CHARS) break;
  }
  void cdpTry(tabId, 'IO.close', { handle });
  return ok ? text : null;
}

/**
 * Resolve a script's source map: decode an inline `data:` URL locally, fetch an
 * external `.map` via CDP. Null when the script has no map or anything fails.
 */
async function loadSourceMap(
  tabId: string,
  script: ScriptInfo | undefined,
): Promise<ScriptSourceMap | null> {
  const rawUrl = script?.sourceMapURL;
  if (!script || !rawUrl) return null;
  let text: string | null = null;
  if (rawUrl.startsWith('data:')) {
    text = decodeSourceMapDataUrl(rawUrl);
  } else {
    const mapUrl = resolveUrl(rawUrl, script.url);
    if (mapUrl && isHttpUrl(mapUrl)) {
      text = await fetchCdpResource(tabId, mapUrl, script.frameId);
    }
  }
  if (!text) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const map = parseSourceMap(json);
  if (!map) return null;
  return {
    map,
    sourceUrls: map.sources.map((s) => resolveSourceUrl(map.sourceRoot, s, script.url)),
  };
}

export function createSourcesSlice(set: SetState, get: GetState): SourcesActions {
  /** Fire-and-forget a Debugger command against the bound tab. */
  const dbg = (method: string, params?: object) => {
    const tabId = get().tabId;
    if (tabId) void cdpTry(tabId, method, params);
  };

  /** Scroll the viewer to a 0-based line of whatever text it displays. */
  const bumpReveal = (line: number) =>
    set((s) => ({ reveal: { line, seq: (s.reveal?.seq ?? 0) + 1 } }));

  // Source-map loads in flight, keyed tabId:scriptId — a 20 MB .map fetched
  // twice concurrently would be pure waste.
  const mapInFlight = new Set<string>();

  // Monotonic watch round — a slow round that lost to a newer one must not
  // clobber its results.
  let watchSeq = 0;

  return {
    selectScript: async (scriptId) => {
      const tabId = get().tabId;
      if (!tabId) return;
      if (get().selectedScriptId === scriptId && get().scriptSource !== null) return;
      set({
        selectedScriptId: scriptId,
        scriptSource: null,
        scriptSourceLoading: true,
        original: null,
        reveal: null,
      });
      const res = await cdpTry<{ scriptSource: string }>(
        tabId,
        'Debugger.getScriptSource',
        { scriptId },
      );
      // Selection moved / session rebound while awaiting — drop the stale source.
      if (get().tabId !== tabId || get().selectedScriptId !== scriptId) return;
      set({ scriptSource: res?.scriptSource ?? null, scriptSourceLoading: false });
    },

    openScript: async (scriptId) => {
      // Sidebar click: select the script, then default to the Original view
      // when a source map resolves (best-effort — generated view otherwise).
      // Re-clicking the already-selected script while in Original mode shows
      // the compiled bundle the row names.
      if (
        get().selectedScriptId === scriptId &&
        get().scriptSource !== null &&
        get().original !== null
      ) {
        get().showCompiledSource();
        return;
      }
      await get().selectScript(scriptId);
      if (get().selectedScriptId !== scriptId) return;
      await get()._ensureSourceMap(scriptId);
      if (get().selectedScriptId !== scriptId || get().original !== null) return;
      const rec = get().sourceMaps.get(scriptId);
      if (rec && rec.map.sources.length > 0) {
        await get().selectOriginalSource(scriptId, defaultSourceIndex(rec.map));
      }
    },

    openScriptAt: async (scriptId, lineNumber) => {
      await get().selectScript(scriptId);
      if (get().selectedScriptId !== scriptId) return;
      bumpReveal(lineNumber);
    },

    revealBreakpoint: async (bp) => {
      // Breakpoints are url-keyed; resolve the current page's script for that
      // URL (after a reload the scriptId differs but the URL matches). The
      // generated location maps back to the original view when a map resolves.
      for (const script of get().scripts.values()) {
        if (script.url === bp.url) {
          await get().revealLocation(script.scriptId, bp.lineNumber, bp.columnNumber ?? 0);
          return;
        }
      }
    },

    revealLocation: async (scriptId, lineNumber, columnNumber = 0) => {
      // Reveal a GENERATED location, preferring its mapped original source
      // (pause/call-stack navigation). Falls back to the generated view when
      // the map or the original content is unavailable.
      const tabId = get().tabId;
      if (!tabId) return;
      await get().selectScript(scriptId);
      if (get().tabId !== tabId || get().selectedScriptId !== scriptId) return;
      await get()._ensureSourceMap(scriptId);
      if (get().tabId !== tabId || get().selectedScriptId !== scriptId) return;
      const rec = get().sourceMaps.get(scriptId);
      const pos = rec ? originalPositionFor(rec.map, lineNumber, columnNumber) : null;
      if (pos) {
        await get().selectOriginalSource(scriptId, pos.srcIndex);
        const orig = get().original;
        if (
          get().tabId === tabId &&
          get().selectedScriptId === scriptId &&
          orig !== null &&
          orig.srcIndex === pos.srcIndex &&
          orig.text !== null
        ) {
          bumpReveal(pos.line);
          return;
        }
        // Original content unavailable — show the generated source instead.
        if (get().selectedScriptId === scriptId) set({ original: null });
      }
      if (get().selectedScriptId === scriptId) bumpReveal(lineNumber);
    },

    selectOriginalSource: async (scriptId, srcIndex) => {
      const tabId = get().tabId;
      if (!tabId) return;
      if (get().selectedScriptId !== scriptId) await get().selectScript(scriptId);
      if (get().tabId !== tabId || get().selectedScriptId !== scriptId) return;
      await get()._ensureSourceMap(scriptId);
      if (get().tabId !== tabId || get().selectedScriptId !== scriptId) return;
      const rec = get().sourceMaps.get(scriptId);
      if (!rec || srcIndex < 0 || srcIndex >= rec.map.sources.length) return;
      const embedded = rec.map.sourcesContent[srcIndex];
      if (typeof embedded === 'string') {
        set({ original: { srcIndex, text: embedded, loading: false } });
        return;
      }
      // No embedded content — try retrieving the original file via CDP (only
      // meaningful for http(s) sources the dev server actually serves).
      set({ original: { srcIndex, text: null, loading: true } });
      const url = rec.sourceUrls[srcIndex];
      const text = isHttpUrl(url)
        ? await fetchCdpResource(tabId, url, get().scripts.get(scriptId)?.frameId)
        : null;
      if (get().tabId !== tabId || get().selectedScriptId !== scriptId) return;
      const cur = get().original;
      if (!cur || cur.srcIndex !== srcIndex) return; // user moved on
      if (text !== null) {
        // Cache into the parsed map so re-opening this source doesn't refetch.
        rec.map.sourcesContent[srcIndex] = text;
      }
      set({ original: { srcIndex, text, loading: false } });
    },

    showCompiledSource: () => {
      if (get().original !== null) set({ original: null });
    },

    toggleBreakpoint: async (url, lineNumber, original) => {
      const tabId = get().tabId;
      if (!tabId || !url) return;
      const existing = get().breakpoints.find(
        (b) => b.url === url && b.lineNumber === lineNumber,
      );
      if (existing) {
        set({
          breakpoints: get().breakpoints.filter((b) => b !== existing),
        });
        if (existing.id) {
          await cdpTry(tabId, 'Debugger.removeBreakpoint', {
            breakpointId: existing.id,
          });
        }
        return;
      }
      const res = await cdpTry<{ breakpointId: string }>(
        tabId,
        'Debugger.setBreakpointByUrl',
        { lineNumber, url, columnNumber: original?.columnNumber ?? 0 },
      );
      if (!res) return; // command failed — don't record a dead breakpoint
      // Note: re-check for a duplicate in case of a rapid double-click race.
      const dup = get().breakpoints.some(
        (b) => b.url === url && b.lineNumber === lineNumber,
      );
      if (dup) return;
      set({
        breakpoints: [
          ...get().breakpoints,
          {
            id: res.breakpointId,
            url,
            lineNumber,
            columnNumber: original?.columnNumber,
            original: original
              ? { url: original.url, lineNumber: original.lineNumber }
              : undefined,
          },
        ],
      });
    },

    toggleOriginalBreakpoint: async (lineNumber) => {
      // Gutter click in the original view: map the original line to the
      // nearest generated mapping at-or-after it and set/remove through the
      // url:line path so sticky re-apply keeps working unchanged.
      const scriptId = get().selectedScriptId;
      const orig = get().original;
      if (!scriptId || orig === null) return;
      const script = get().scripts.get(scriptId);
      const rec = get().sourceMaps.get(scriptId);
      if (!script?.url || !rec) return;
      const srcUrl = rec.sourceUrls[orig.srcIndex];
      const existing = get().breakpoints.find(
        (b) => b.original?.url === srcUrl && b.original.lineNumber === lineNumber,
      );
      if (existing) {
        await get().toggleBreakpoint(existing.url, existing.lineNumber);
        return;
      }
      const gen = generatedPositionFor(rec.map, orig.srcIndex, lineNumber);
      if (!gen) return; // line is beyond the source's mappings — no-op
      await get().toggleBreakpoint(script.url, gen.line, {
        url: srcUrl,
        lineNumber,
        columnNumber: gen.column,
      });
    },

    setPauseOnExceptions: (state) => {
      set({ pauseOnExceptions: state });
      dbg('Debugger.setPauseOnExceptions', { state });
    },

    pause: () => dbg('Debugger.pause'),
    resume: () => dbg('Debugger.resume'),
    stepOver: () => dbg('Debugger.stepOver'),
    stepInto: () => dbg('Debugger.stepInto'),
    stepOut: () => dbg('Debugger.stepOut'),

    selectCallFrame: (index) => {
      const paused = get().paused;
      const frame = paused?.callFrames[index];
      if (!paused || !frame) return;
      set({ paused: { ...paused, frameIndex: index } });
      void get().revealLocation(
        frame.location.scriptId,
        frame.location.lineNumber,
        frame.location.columnNumber ?? 0,
      );
      // Watches evaluate against the selected frame — follow it.
      void get().refreshWatches();
    },

    /* ── DOMDebugger breakpoints (XHR/fetch + event listeners) ─────────── */

    addXhrBreakpoint: (url) => {
      // The empty string is meaningful: break on ANY XHR/fetch.
      const trimmed = url.trim();
      if (get().xhrBreakpoints.some((b) => b.url === trimmed)) return;
      set({ xhrBreakpoints: [...get().xhrBreakpoints, { url: trimmed, enabled: true }] });
      dbg('DOMDebugger.setXHRBreakpoint', { url: trimmed });
    },

    removeXhrBreakpoint: (url) => {
      const bp = get().xhrBreakpoints.find((b) => b.url === url);
      if (!bp) return;
      set({ xhrBreakpoints: get().xhrBreakpoints.filter((b) => b.url !== url) });
      if (bp.enabled) dbg('DOMDebugger.removeXHRBreakpoint', { url });
    },

    toggleXhrBreakpoint: (url, enabled) => {
      if (!get().xhrBreakpoints.some((b) => b.url === url)) return;
      set({
        xhrBreakpoints: get().xhrBreakpoints.map((b) =>
          b.url === url ? { ...b, enabled } : b,
        ),
      });
      dbg(
        enabled ? 'DOMDebugger.setXHRBreakpoint' : 'DOMDebugger.removeXHRBreakpoint',
        { url },
      );
    },

    toggleEventBreakpoint: (name, enabled) => {
      const next = new Set(get().eventBreakpoints);
      if (enabled) next.add(name);
      else next.delete(name);
      set({ eventBreakpoints: next });
      // The protocol takes the PLAIN event name; the paused event reports it
      // back with the 'listener:' category prefix (see pausedReasonLabel).
      dbg(
        enabled
          ? 'DOMDebugger.setEventListenerBreakpoint'
          : 'DOMDebugger.removeEventListenerBreakpoint',
        { eventName: name },
      );
    },

    /* ── watch expressions ──────────────────────────────────────────────── */

    addWatch: (expression) => {
      const trimmed = expression.trim();
      if (!trimmed || get().watchExpressions.includes(trimmed)) return;
      set({ watchExpressions: [...get().watchExpressions, trimmed] });
      void get().refreshWatches();
    },

    removeWatch: (expression) => {
      const results = new Map(get().watchResults);
      results.delete(expression);
      set({
        watchExpressions: get().watchExpressions.filter((e) => e !== expression),
        watchResults: results,
      });
    },

    refreshWatches: async () => {
      const tabId = get().tabId;
      const exprs = get().watchExpressions;
      if (!tabId || exprs.length === 0) return;
      const seq = ++watchSeq;
      // Previous round's RemoteObjects are dead weight on the page — release.
      void cdpTry(tabId, 'Runtime.releaseObjectGroup', { objectGroup: WATCH_GROUP });
      const paused = get().paused;
      const frame = paused?.callFrames[paused.frameIndex];
      const results = new Map<string, WatchResult>();
      for (const expression of exprs) {
        const res = frame
          ? await cdpTry<CdpEvalResult>(tabId, 'Debugger.evaluateOnCallFrame', {
              callFrameId: frame.callFrameId,
              expression,
              objectGroup: WATCH_GROUP,
              generatePreview: true,
            })
          : await cdpTry<CdpEvalResult>(tabId, 'Runtime.evaluate', {
              expression,
              objectGroup: WATCH_GROUP,
              generatePreview: true,
            });
        if (!res) {
          results.set(expression, { error: 'Not available' });
        } else if (res.exceptionDetails) {
          const desc =
            res.exceptionDetails.exception?.description ?? res.exceptionDetails.text;
          results.set(expression, { error: desc.split('\n', 1)[0] });
        } else {
          results.set(expression, { value: res.result });
        }
      }
      if (get().tabId !== tabId || watchSeq !== seq) return; // stale round
      set({ watchResults: results });
    },

    /* ── source maps (P5b) ──────────────────────────────────────────────── */

    _ensureSourceMap: async (scriptId) => {
      // Resolve (once) the script's source map into the per-page cache. The
      // cache stores null for "tried and failed/absent" so a map-less script
      // is never re-fetched. Strictly best-effort.
      const tabId = get().tabId;
      if (!tabId) return;
      if (get().sourceMaps.has(scriptId)) return;
      const key = `${tabId}:${scriptId}`;
      if (mapInFlight.has(key)) return;
      mapInFlight.add(key);
      let record: ScriptSourceMap | null;
      try {
        record = await loadSourceMap(tabId, get().scripts.get(scriptId));
      } catch {
        record = null; // never let a map failure escape
      } finally {
        mapInFlight.delete(key);
      }
      // Session rebound / page navigated while fetching — the cache was reset.
      if (get().tabId !== tabId || !get().scripts.has(scriptId)) return;
      if (get().sourceMaps.has(scriptId)) return;
      const next = new Map(get().sourceMaps);
      next.set(scriptId, record);
      set({ sourceMaps: next });
    },

    /* ── sticky state re-application (fresh Debugger.enable) ───────────── */

    _applySources: async () => {
      const tabId = get().tabId;
      if (!tabId) return;
      const { pauseOnExceptions, breakpoints } = get();
      if (pauseOnExceptions !== 'none') {
        await cdpTry(tabId, 'Debugger.setPauseOnExceptions', {
          state: pauseOnExceptions,
        });
      }
      // Re-set every url:line breakpoint. On a brand-new session each set
      // succeeds and refreshes the id; after a same-session re-enable the set
      // fails with "already exists" (cdpTry swallows it) and the old id stays
      // valid — both paths converge on a live breakpoint.
      for (const bp of breakpoints) {
        const res = await cdpTry<{ breakpointId: string }>(
          tabId,
          'Debugger.setBreakpointByUrl',
          { lineNumber: bp.lineNumber, url: bp.url, columnNumber: bp.columnNumber ?? 0 },
        );
        if (get().tabId !== tabId) return;
        if (res) {
          set({
            breakpoints: get().breakpoints.map((b) =>
              b.url === bp.url && b.lineNumber === bp.lineNumber
                ? { ...b, id: res.breakpointId }
                : b,
            ),
          });
        }
      }
      // Re-arm the sticky DOMDebugger breakpoints (set/remove is idempotent).
      for (const xhr of get().xhrBreakpoints) {
        if (!xhr.enabled) continue;
        await cdpTry(tabId, 'DOMDebugger.setXHRBreakpoint', { url: xhr.url });
        if (get().tabId !== tabId) return;
      }
      for (const name of get().eventBreakpoints) {
        await cdpTry(tabId, 'DOMDebugger.setEventListenerBreakpoint', {
          eventName: name,
        });
        if (get().tabId !== tabId) return;
      }
      // Fresh session/page — re-evaluate the sticky watch expressions.
      void get().refreshWatches();
    },

    /* ── pause machine (Debugger.paused / Debugger.resumed) ────────────── */

    _handlePaused: (params) => {
      const p = (params ?? {}) as {
        reason?: unknown;
        callFrames?: unknown;
        data?: unknown;
      };
      const callFrames: DebuggerCallFrame[] = Array.isArray(p.callFrames)
        ? (p.callFrames as DebuggerCallFrame[])
        : [];
      const paused: PausedInfo = {
        reason: typeof p.reason === 'string' ? p.reason : 'other',
        callFrames,
        frameIndex: 0,
        data:
          typeof p.data === 'object' && p.data !== null
            ? (p.data as Record<string, unknown>)
            : undefined,
      };
      set({ paused });
      // Reveal the top frame — Debugger/Runtime commands work while paused.
      // revealLocation prefers the mapped original source when available.
      const top = callFrames[0];
      if (top) {
        void get().revealLocation(
          top.location.scriptId,
          top.location.lineNumber,
          top.location.columnNumber ?? 0,
        );
      }
      // Kick best-effort map resolution for the rest of the stack so frame
      // rows can display mapped original locations (bounded fan-out).
      const stackScripts = [...new Set(callFrames.map((f) => f.location.scriptId))];
      for (const scriptId of stackScripts.slice(0, 8)) {
        void get()._ensureSourceMap(scriptId);
      }
      void get().refreshWatches();
    },

    _handleResumed: () => {
      if (get().paused !== null) set({ paused: null });
      // Back to Runtime.evaluate semantics — recompute against the page.
      void get().refreshWatches();
    },
  };
}
