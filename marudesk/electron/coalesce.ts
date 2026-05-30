/**
 * Coalesce a burst of calls into one deferred run per tick (setImmediate).
 * Returns a `schedule` function: calling it any number of times within a tick
 * runs `fn` exactly once, on the next tick, after which it re-arms.
 *
 * This is the shared shape behind every "the renderer only needs the latest
 * state, not each intermediate one" flush in main: the CDP event relay
 * (electron/browser/cdp.ts), the tab-state push (electron/browser/state.ts), and
 * the agent event stream (electron/agent/loop.ts). Each can fire a burst per
 * navigation / per step but should cross IPC once per tick.
 */
export function coalesced(fn: () => void): () => void {
  let scheduled = false;
  return () => {
    if (scheduled) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      fn();
    });
  };
}
