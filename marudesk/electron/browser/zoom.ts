import { getActive, getPaneBounds, getPaneScale, type TabRecord } from './state';

/**
 * Per-tab page zoom (Ctrl +/-/0). The chosen factor is stored on the tab record
 * and re-applied after each navigation (Chromium otherwise resets zoom on a
 * cross-document load), so a tab keeps its zoom as the user browses within it.
 * The factor rides along in NavState (state.ts) so the toolbar indicator stays
 * correct across tab switches.
 *
 * Package leaf-consumer: imports only ./state — no sibling cycle.
 */

// Discrete zoom rungs, matching the round percentages a browser exposes
// (25% … 500%). Stepping along a ladder gives nicer values than a raw
// multiplier and bounds the range without a separate clamp.
const ZOOM_STEPS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4,
  5,
] as const;

function nearestIndex(factor: number): number {
  let best = 0;
  let bestDelta = Infinity;
  for (let i = 0; i < ZOOM_STEPS.length; i++) {
    const d = Math.abs(ZOOM_STEPS[i] - factor);
    if (d < bestDelta) {
      bestDelta = d;
      best = i;
    }
  }
  return best;
}

/**
 * Adjust the active tab's zoom and return the new factor (1 = 100%). A
 * feature/no-view tab is a no-op that reports 100%.
 */
export function zoomActive(direction: 'in' | 'out' | 'reset'): number {
  const active = getActive();
  if (!active || !active.view) return 1;
  // On the canvas the canvas zoom owns the page scale — per-page zoom would just
  // be overwritten on the next layout, so make it a no-op there.
  const paneScale = getPaneScale();
  if (paneScale != null && getPaneBounds()?.has(active.id)) return paneScale;
  let next: number;
  if (direction === 'reset') {
    next = 1;
  } else {
    const idx = nearestIndex(active.zoomFactor ?? 1);
    const step = direction === 'in' ? 1 : -1;
    next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, idx + step))];
  }
  active.zoomFactor = next;
  active.view.webContents.setZoomFactor(next);
  return next;
}

/** Re-apply a tab's stored zoom (called after navigation resets it). */
export function reapplyZoom(rec: TabRecord): void {
  if (!rec.view) return;
  // On the canvas, a card's view renders at the canvas zoom; keep it after a
  // navigation resets Chromium's zoom, rather than the tab's own page zoom.
  const paneScale = getPaneScale();
  if (paneScale != null && getPaneBounds()?.has(rec.id)) {
    rec.view.webContents.setZoomFactor(paneScale);
    return;
  }
  const factor = rec.zoomFactor ?? 1;
  if (factor !== 1) rec.view.webContents.setZoomFactor(factor);
}
