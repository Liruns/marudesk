import { scrubText } from '../../../shared/scrub';
import type { ToolContext, ToolResult } from './types';
import { requireTab, evaluate } from './shared-helpers.ts';

/**
 * The `get_web_vitals` tool: read Core Web Vitals + basic navigation timing from
 * the LIVE page via the same injection-safe `Runtime.evaluate` path as eval_js /
 * query_dom (the Rendering DevTools panel only toggles the CDP overlay —
 * `Overlay.setShowWebVitals` — which paints in-page; this tool returns the
 * numbers to the model instead). Buffered PerformanceObserver entries can be
 * unavailable (long-lived documents, unsupported entry types) — every metric
 * degrades to "not available" rather than failing the call.
 */

/** What the in-page expression resolves to (JSON-serializable only). */
type VitalsPayload = {
  lcp: { t: number; size: number; tag: string | null } | null;
  /** Cumulative layout shift (sum of non-input shifts); null = unobservable. */
  cls: number | null;
  fid: number | null;
  inp: number | null;
  ttfb: number | null;
  nav: { domContentLoaded: number; load: number; transferSize: number; type: string } | null;
  paint: { name: string; t: number }[];
};

// Fixed, injection-safe expression (no interpolated input). Each entry type is
// observed with buffered:true and collected after a short settle; an
// unsupported type resolves null instead of throwing. Promise is awaited by
// the shared `evaluate` helper (awaitPromise).
const VITALS_EXPR = `(() => {
  const collect = (type, opts) => new Promise((resolve) => {
    try {
      const got = [];
      const po = new PerformanceObserver((list) => { got.push(...list.getEntries()); });
      po.observe(Object.assign({ type, buffered: true }, opts || {}));
      setTimeout(() => {
        try { got.push(...po.takeRecords()); po.disconnect(); } catch (e) {}
        resolve(got);
      }, 120);
    } catch (e) { resolve(null); }
  });
  return Promise.all([
    collect('largest-contentful-paint'),
    collect('layout-shift'),
    collect('first-input'),
    collect('event', { durationThreshold: 40 }),
  ]).then(([lcp, shifts, firstInput, events]) => {
    const nav = performance.getEntriesByType('navigation')[0] || null;
    const last = lcp && lcp.length ? lcp[lcp.length - 1] : null;
    let tag = null;
    try { tag = last && last.element ? last.element.tagName : null; } catch (e) {}
    const cls = shifts
      ? shifts.filter((s) => !s.hadRecentInput).reduce((sum, s) => sum + s.value, 0)
      : null;
    const fi = firstInput && firstInput.length ? firstInput[0] : null;
    const interactions = events ? events.filter((ev) => ev.interactionId) : null;
    const inp = interactions && interactions.length
      ? interactions.reduce((m, ev) => Math.max(m, ev.duration), 0)
      : null;
    return {
      lcp: last ? { t: last.startTime, size: last.size, tag } : null,
      cls,
      fid: fi ? fi.processingStart - fi.startTime : null,
      inp,
      ttfb: nav ? nav.responseStart - nav.startTime : null,
      nav: nav
        ? {
            domContentLoaded: nav.domContentLoadedEventEnd - nav.startTime,
            load: nav.loadEventEnd - nav.startTime,
            transferSize: nav.transferSize || 0,
            type: nav.type || 'navigate',
          }
        : null,
      paint: performance.getEntriesByType('paint').map((p) => ({ name: p.name, t: p.startTime })),
    };
  });
})()`;

/** web.dev thresholds: good ≤ good, poor > poor, in between needs improvement. */
function rate(value: number, good: number, poor: number): string {
  return value <= good ? 'good' : value <= poor ? 'needs improvement' : 'poor';
}

const ms = (v: number): string => `${Math.round(v)} ms`;

function formatVitals(v: VitalsPayload): string {
  const lines: string[] = [];
  lines.push(
    v.lcp
      ? `- LCP: ${ms(v.lcp.t)} (${rate(v.lcp.t, 2500, 4000)})${v.lcp.tag ? ` — element <${v.lcp.tag}>` : ''}`
      : '- LCP: not available (no buffered largest-contentful-paint entry)',
  );
  lines.push(
    v.cls !== null
      ? `- CLS: ${v.cls.toFixed(3)} (${rate(v.cls, 0.1, 0.25)})`
      : '- CLS: not available (layout-shift observation unsupported)',
  );
  lines.push(
    v.inp !== null
      ? `- INP (worst observed interaction): ${ms(v.inp)} (${rate(v.inp, 200, 500)})`
      : '- INP: not available — needs user interactions ≥40ms; interact with the page (click/fill) and re-read',
  );
  lines.push(
    v.fid !== null
      ? `- FID: ${ms(v.fid)} (${rate(v.fid, 100, 300)})`
      : '- FID: not available (no first input observed yet)',
  );
  lines.push(
    v.ttfb !== null
      ? `- TTFB: ${ms(v.ttfb)} (${rate(v.ttfb, 800, 1800)})`
      : '- TTFB: not available (no navigation timing entry)',
  );
  const fcp = v.paint.find((p) => p.name === 'first-contentful-paint');
  if (fcp) lines.push(`- FCP: ${ms(fcp.t)} (${rate(fcp.t, 1800, 3000)})`);
  if (v.nav) {
    const kb = (v.nav.transferSize / 1024).toFixed(1);
    lines.push(
      `Navigation (${v.nav.type}): DOMContentLoaded ${ms(v.nav.domContentLoaded)}, load ${ms(v.nav.load)}, transfer ${kb} KB`,
    );
  }
  return lines.join('\n');
}

export async function getWebVitals(_input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const rec = requireTab(ctx);
  const out = await evaluate(rec, VITALS_EXPR);
  if (!out.ok) {
    return {
      summary: 'get_web_vitals failed',
      text: `could not read performance entries — ${scrubText(out.error)}`,
      isError: true,
    };
  }
  if (!out.value || typeof out.value !== 'object') {
    return {
      summary: 'get_web_vitals',
      text: 'The page returned no performance data (it may not support the Performance API).',
    };
  }
  const v = out.value as VitalsPayload;
  return {
    summary: 'web vitals',
    text: `Web Vitals for the current document:\n${formatVitals(v)}\n\nNote: values are for the CURRENT document since its navigation. For a fresh measurement, reload_and_verify first, then re-read; INP/FID need real interactions.`,
  };
}
