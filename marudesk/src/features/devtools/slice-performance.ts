import type { StoreApi } from 'zustand';
import { cdpTry } from './cdp';
import { parseCdpProfile, processProfile } from './performance-utils';
import type { PerfMetric } from './types';
import type { DevtoolsState, DevtoolsActions } from './store';

type DevtoolsStore = DevtoolsState & DevtoolsActions;
type SetState = StoreApi<DevtoolsStore>['setState'];
type GetState = StoreApi<DevtoolsStore>['getState'];

type PerformanceActions = Pick<
  DevtoolsActions,
  'refreshMetrics' | 'startProfiling' | 'stopProfiling'
>;

// Sampling resolution in microseconds. The CDP default (1000) is too coarse for
// short interactions; 100 matches Chrome DevTools' high-resolution profiles.
const SAMPLING_INTERVAL_US = 100;

/**
 * The Performance panel actions for the devtools store: on-demand live metrics
 * (Performance.getMetrics — pulled, no event stream) and the sampling CPU
 * profiler (Profiler.start/stop → processed into the top-down/bottom-up views
 * by performance-utils). Follows the slice-creator pattern of its siblings.
 *
 * Recording state never outlives the session it belongs to: navigation stops a
 * recording (slice-session._handleNavigated) and detach/rebind resets it via
 * freshSlices — a FINISHED processed profile survives navigation (it is a
 * historical snapshot, like DevTools' saved profiles) but not a rebind.
 */
export function createPerformanceSlice(set: SetState, get: GetState): PerformanceActions {
  return {
    refreshMetrics: async () => {
      const tabId = get().tabId;
      if (!tabId || get().session !== 'attached') return;
      // Performance.enable starts Chromium's collection; getMetrics reads it.
      await get()._ensureDomains(['Performance']);
      const res = await cdpTry<{ metrics: PerfMetric[] }>(tabId, 'Performance.getMetrics');
      if (get().tabId !== tabId) return; // rebound while awaiting — drop
      if (!res) return; // command failed (navigating) — keep the last snapshot
      const metrics = (res.metrics ?? []).filter(
        (m): m is PerfMetric =>
          !!m && typeof m.name === 'string' && typeof m.value === 'number',
      );
      set({ perfMetrics: metrics, perfMetricsAt: Date.now() });
    },

    startProfiling: async () => {
      const tabId = get().tabId;
      if (!tabId || get().profiling || get().session !== 'attached') return;
      const epoch = get().epoch;
      await get()._ensureDomains(['Profiler']);
      // The interval must be set before the profile starts (no-op otherwise).
      await cdpTry(tabId, 'Profiler.setSamplingInterval', {
        interval: SAMPLING_INTERVAL_US,
      });
      const started = await cdpTry(tabId, 'Profiler.start');
      if (get().tabId !== tabId || get().epoch !== epoch) return;
      if (started === undefined) return; // start failed — stay idle
      set({ profiling: true, profile: null });
    },

    stopProfiling: async () => {
      const tabId = get().tabId;
      if (!tabId || !get().profiling) return;
      // Flip the flag first so a double-click can't issue two stops.
      set({ profiling: false });
      const res = await cdpTry<{ profile: unknown }>(tabId, 'Profiler.stop');
      if (get().tabId !== tabId) return;
      const parsed = res ? parseCdpProfile(res.profile) : null;
      if (parsed) set({ profile: processProfile(parsed) });
    },
  };
}
