/**
 * Promise-based delay. Lives in `shared/` so main-process modules (OAuth
 * polling, workflow replay) and tests share one implementation instead of
 * re-declaring the same one-liner per file.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
