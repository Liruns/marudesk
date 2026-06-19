import assert from 'node:assert/strict';

/**
 * Shared assertion helpers for the headless harnesses (the `harness:*`
 * scripts), so each harness stops re-declaring its own `check`/`expectReject`.
 * Output shape (`  ok N - label`) is what the existing harnesses print and what
 * `scripts/run-harnesses.mjs` buffers into its summary.
 *
 * Style: strict — a failed check throws immediately (assert), aborting the
 * harness with a non-zero exit. One harness per process, so the pass counter
 * can be module state. New harnesses should import from here; existing ones
 * migrate opportunistically when touched.
 */

let passed = 0;

/** Assert `condition`, count and log the pass. Throws (exits the harness) on failure. */
export function check(label: string, condition: boolean): void {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

/** Run `action`, expect it to reject with a message matching `pattern`. */
export async function expectReject(
  label: string,
  action: () => Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  let message = '';
  try {
    await action();
  } catch (err) {
    // Inlined from shared/to-message so this kit stays dependency-free and
    // resolves under the plain `--experimental-strip-types` harnesses (no
    // loader hook) as well as the loader-based ones. Same result as toMessage.
    message = err instanceof Error ? err.message : String(err);
  }
  check(label, pattern.test(message));
}

/** Total passed checks so far — for the harness's final summary line. */
export function passedCount(): number {
  return passed;
}
