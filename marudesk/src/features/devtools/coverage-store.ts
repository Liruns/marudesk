import { create } from 'zustand';
import { cdpTry } from './cdp';
import { useDevtoolsStore } from './store';
import { isInternalScriptUrl } from './sources-utils';
import {
  cssSheetUsage,
  jsScriptUsage,
  sortByUnusedDesc,
  type CoverageRow,
} from './coverage-utils';
import type { CssRuleUsage, ProfilerScriptCoverage } from './types';

/**
 * Coverage instrumentation state for the Rendering panel's Coverage section,
 * kept as its own small store (the main devtools store is per-panel slices; this
 * stays self-contained so start/stop survives panel switches). Start arms
 * `Profiler.startPreciseCoverage` (JS) + `CSS.startRuleUsageTracking` (CSS);
 * stop drains both into per-script / per-stylesheet used-vs-total byte rows,
 * sorted by unused bytes (the dead weight first).
 *
 * Domain enabling: Profiler is enabled directly here (best-effort), DOM+CSS go
 * through the session's `_ensureDomains` so the enabled-set bookkeeping stays
 * consistent. Instrumentation does not survive a navigation — V8 and the CSS
 * agent drop their tracking with the document, so cross-page rows read low.
 */

type CoverageState = {
  recording: boolean;
  /** The tab the recording was armed on (stop targets it even after a rebind). */
  tabId: string | null;
  rows: CoverageRow[];
  /** A start/stop round-trip is in flight — buttons disable. */
  busy: boolean;
};

type CoverageActions = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  clear: () => void;
};

// stopRuleUsageTracking can report thousands of rules on a heavy page; cap the
// per-sheet text fetches so stop stays bounded.
const MAX_CSS_SHEETS = 50;

export const useCoverageStore = create<CoverageState & CoverageActions>((set, get) => ({
  recording: false,
  tabId: null,
  rows: [],
  busy: false,

  start: async () => {
    if (get().busy || get().recording) return;
    const devtools = useDevtoolsStore.getState();
    const tabId = devtools.tabId;
    if (!tabId || devtools.session !== 'attached') return;
    set({ busy: true });
    // CSS rule tracking needs DOM+CSS live (styleSheetAdded headers also feed
    // the URL column); Profiler is coverage-only, enabled directly.
    await devtools._ensureDomains(['DOM', 'CSS']);
    await cdpTry(tabId, 'Profiler.enable');
    const js = await cdpTry(tabId, 'Profiler.startPreciseCoverage', {
      callCount: false,
      detailed: true,
    });
    const css = await cdpTry(tabId, 'CSS.startRuleUsageTracking');
    if (js === undefined && css === undefined) {
      // Both arms failed (detached mid-flight) — stay idle.
      set({ busy: false });
      return;
    }
    set({ recording: true, tabId, rows: [], busy: false });
  },

  stop: async () => {
    const { recording, tabId, busy } = get();
    if (!recording || !tabId || busy) return;
    set({ busy: true });
    const rows: CoverageRow[] = [];

    // JS: snapshot, then drop the instrumentation.
    const take = await cdpTry<{ result: ProfilerScriptCoverage[] }>(
      tabId,
      'Profiler.takePreciseCoverage',
    );
    void cdpTry(tabId, 'Profiler.stopPreciseCoverage');
    for (const script of take?.result ?? []) {
      if (!script.url || isInternalScriptUrl(script.url)) continue;
      const { usedBytes, totalBytes } = jsScriptUsage(script.functions);
      if (totalBytes === 0) continue;
      rows.push({ id: `js:${script.scriptId}`, url: script.url, kind: 'js', usedBytes, totalBytes });
    }

    // CSS: the stop call returns the rule-usage delta since start.
    const css = await cdpTry<{ ruleUsage: CssRuleUsage[] }>(tabId, 'CSS.stopRuleUsageTracking');
    const bySheet = new Map<string, CssRuleUsage[]>();
    for (const usage of css?.ruleUsage ?? []) {
      const list = bySheet.get(usage.styleSheetId);
      if (list) list.push(usage);
      else bySheet.set(usage.styleSheetId, [usage]);
    }
    const headers = useDevtoolsStore.getState().styleSheets;
    for (const [styleSheetId, ranges] of [...bySheet].slice(0, MAX_CSS_SHEETS)) {
      // Total bytes: the served sheet text (the headers we keep don't carry a
      // length); falls back to the ranges' extent when the fetch fails.
      const sheet = await cdpTry<{ text: string }>(tabId, 'CSS.getStyleSheetText', {
        styleSheetId,
      });
      const { usedBytes, totalBytes } = cssSheetUsage(ranges, sheet?.text.length ?? 0);
      if (totalBytes === 0) continue;
      const url = headers.get(styleSheetId)?.sourceURL || '(inline stylesheet)';
      rows.push({ id: `css:${styleSheetId}`, url, kind: 'css', usedBytes, totalBytes });
    }

    set({ recording: false, rows: sortByUnusedDesc(rows), busy: false });
  },

  clear: () => set({ rows: [] }),
}));
