import type { NativeImage } from 'electron';

/**
 * Bounded retry around `webContents.capturePage()`.
 *
 * Under load Chromium's Viz/compositor can transiently REJECT a capture
 * (e.g. `UnknownVizError`) or hand back an EMPTY image for a frame that simply
 * has not painted yet — the very next frame would succeed. Both are treated as
 * the same retryable "miss": we re-attempt up to `attempts` times with a short
 * backoff before giving up. A view that genuinely never paints resolves to
 * `null` after the budget is exhausted (callers map that to their existing
 * empty-result contract).
 *
 * The capturer, the emptiness predicate, and the delay are all injectable so
 * the policy is unit-testable WITHOUT Electron and without leaning on wall-clock
 * time or randomness.
 */

/** Default backoff schedule (ms) between attempts after a miss. */
const DEFAULT_BACKOFF_MS: readonly number[] = [50, 100, 200];

export interface CaptureRetryDeps {
  /** Attempt a single capture. May reject (transient Viz error) or resolve. */
  readonly capture: () => Promise<NativeImage>;
  /** True when the captured frame has not painted yet (retryable). */
  readonly isEmpty: (image: NativeImage) => boolean;
  /** Sleep helper; injected so tests need no real timers. Default: setTimeout. */
  readonly delay?: (ms: number) => Promise<void>;
  /**
   * Backoff schedule between attempts. Total attempt count is
   * `backoff.length + 1` (the initial try plus one retry per delay).
   */
  readonly backoff?: readonly number[];
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run the capture with bounded retry. Resolves to the first painted
 * `NativeImage`, or `null` once the attempt budget is exhausted. NEVER rejects:
 * a transient capture rejection is swallowed as a retryable miss.
 */
export async function captureWithRetry(
  deps: CaptureRetryDeps,
): Promise<NativeImage | null> {
  const backoff = deps.backoff ?? DEFAULT_BACKOFF_MS;
  const delay = deps.delay ?? sleep;
  const attempts = backoff.length + 1;

  for (let i = 0; i < attempts; i += 1) {
    let image: NativeImage | null;
    try {
      image = await deps.capture();
    } catch {
      // Transient Viz/compositor rejection — fall through to the retry path.
      image = null;
    }
    if (image && !deps.isEmpty(image)) {
      return image;
    }
    // Miss (rejection or empty frame): wait out the backoff before re-trying,
    // unless this was the final attempt.
    if (i < backoff.length) {
      await delay(backoff[i]);
    }
  }
  return null;
}
