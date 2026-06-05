/**
 * Shared persistence helpers for resizable side panels (Explorer, Source
 * Control, Search, Context drawer). Each panel stores its width under its own
 * localStorage key but the read/clamp/write logic is identical, so it lives
 * here instead of being copy-pasted per panel.
 *
 * Reads are defensive: a missing key, a non-numeric value, or an
 * out-of-[min,max] value all fall back to the panel's default. localStorage may
 * throw (private mode, disabled storage), so every access is guarded.
 */

/** Read a persisted panel width, clamping to `[min, max]` and falling back to `fallback`. */
export function readStoredWidth(key: string, min: number, max: number, fallback: number): number {
  try {
    const value = Number(localStorage.getItem(key));
    if (Number.isFinite(value) && value >= min && value <= max) return value;
  } catch {
    // localStorage unavailable — fall through to the default.
  }
  return fallback;
}

/** Persist a panel width (rounded to a whole pixel). Silently ignores storage errors. */
export function writeStoredWidth(key: string, width: number): void {
  try {
    localStorage.setItem(key, String(Math.round(width)));
  } catch {
    // localStorage unavailable — width simply won't persist across reloads.
  }
}
