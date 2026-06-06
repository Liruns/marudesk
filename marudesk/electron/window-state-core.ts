/**
 * Pure window-state helpers (no electron/fs) so they're unit-testable. The
 * I/O + `screen`/BrowserWindow wiring lives in window-state.ts.
 */

export type WindowState = {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
};

export const DEFAULT_WINDOW_STATE: WindowState = { width: 1440, height: 900, maximized: false };

const MIN_WIDTH = 480;
const MIN_HEIGHT = 360;

/** Coerce arbitrary JSON into a valid WindowState, falling back per-field. */
export function sanitizeWindowState(parsed: unknown): WindowState {
  if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_WINDOW_STATE };
  const o = parsed as Record<string, unknown>;
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined;
  const width = num(o.width);
  const height = num(o.height);
  return {
    x: num(o.x),
    y: num(o.y),
    width: width && width >= MIN_WIDTH ? width : DEFAULT_WINDOW_STATE.width,
    height: height && height >= MIN_HEIGHT ? height : DEFAULT_WINDOW_STATE.height,
    maximized: o.maximized === true,
  };
}

export type Rect = { x: number; y: number; width: number; height: number };

/**
 * True when the window's saved rect still overlaps some display work area. A
 * monitor that was unplugged (or a resolution change) can otherwise restore the
 * window fully off-screen; callers drop x/y (re-centering) when this is false.
 * A state with no x/y is "centered" and always considered visible.
 */
export function isVisibleOn(state: WindowState, areas: readonly Rect[]): boolean {
  if (state.x === undefined || state.y === undefined) return true;
  const { x, y, width, height } = state;
  return areas.some(
    (a) => x < a.x + a.width && x + width > a.x && y < a.y + a.height && y + height > a.y,
  );
}
