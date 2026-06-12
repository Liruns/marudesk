import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, sanitizeSettings } from './settings.ts';

describe('sanitizeSettings devtools dock migration', () => {
  it("falls a legacy persisted 'side' dock back to 'right'", () => {
    const next = sanitizeSettings({ devtools: { defaultDock: 'side' } });
    expect(next.devtools.defaultDock).toBe('right');
  });

  it("falls a legacy persisted 'popup' dock back to 'right'", () => {
    const next = sanitizeSettings({ devtools: { defaultDock: 'popup' } });
    expect(next.devtools.defaultDock).toBe('right');
  });

  it('keeps the current valid dock values as-is', () => {
    for (const dock of ['right', 'bottom', 'chrome'] as const) {
      const next = sanitizeSettings({ devtools: { defaultDock: dock } });
      expect(next.devtools.defaultDock).toBe(dock);
    }
  });

  it("falls back to the BASE's dock (not blindly 'right') on a partial update", () => {
    const base = sanitizeSettings({ devtools: { defaultDock: 'chrome' } });
    const next = sanitizeSettings({ devtools: { defaultDock: 'side' } }, base);
    expect(next.devtools.defaultDock).toBe('chrome');
  });

  it("documents the default dock as 'right'", () => {
    expect(DEFAULT_SETTINGS.devtools.defaultDock).toBe('right');
  });
});
