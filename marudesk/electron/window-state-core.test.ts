import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WINDOW_STATE,
  isVisibleOn,
  sanitizeWindowState,
} from './window-state-core';

describe('sanitizeWindowState', () => {
  it('falls back to defaults for non-objects', () => {
    expect(sanitizeWindowState(null)).toEqual(DEFAULT_WINDOW_STATE);
    expect(sanitizeWindowState('nope')).toEqual(DEFAULT_WINDOW_STATE);
  });

  it('keeps a valid saved state and rounds numbers', () => {
    expect(sanitizeWindowState({ x: 10.6, y: 20.2, width: 1200.9, height: 800.1, maximized: true })).toEqual({
      x: 11,
      y: 20,
      width: 1201,
      height: 800,
      maximized: true,
    });
  });

  it('rejects too-small / non-finite sizes but keeps position', () => {
    const s = sanitizeWindowState({ x: 5, y: 5, width: 10, height: Infinity, maximized: 'yes' });
    expect(s.width).toBe(DEFAULT_WINDOW_STATE.width);
    expect(s.height).toBe(DEFAULT_WINDOW_STATE.height);
    expect(s.maximized).toBe(false);
    expect(s.x).toBe(5);
  });

  it('omits x/y when not provided', () => {
    const s = sanitizeWindowState({ width: 1000, height: 700, maximized: false });
    expect(s.x).toBeUndefined();
    expect(s.y).toBeUndefined();
  });
});

describe('isVisibleOn', () => {
  const display = { x: 0, y: 0, width: 1920, height: 1080 };

  it('treats a centered (no x/y) state as visible', () => {
    expect(isVisibleOn({ width: 800, height: 600, maximized: false }, [display])).toBe(true);
  });

  it('is visible when overlapping a display', () => {
    expect(isVisibleOn({ x: 100, y: 100, width: 800, height: 600, maximized: false }, [display])).toBe(true);
  });

  it('is not visible when fully off every display', () => {
    expect(isVisibleOn({ x: 5000, y: 5000, width: 800, height: 600, maximized: false }, [display])).toBe(false);
  });

  it('is visible on a secondary display', () => {
    const secondary = { x: 1920, y: 0, width: 1920, height: 1080 };
    expect(
      isVisibleOn({ x: 2000, y: 50, width: 800, height: 600, maximized: false }, [display, secondary]),
    ).toBe(true);
  });
});
