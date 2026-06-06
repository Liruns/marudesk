import { app, screen, type BrowserWindow } from 'electron';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { atomicWriteFile } from './fs-safe';
import {
  DEFAULT_WINDOW_STATE,
  isVisibleOn,
  sanitizeWindowState,
  type WindowState,
} from './window-state-core';

/**
 * Window-bounds persistence: remember the main window's size/position and
 * maximized state across restarts (the "닫고 다시 켰을 때 그대로" expectation).
 * Stored as JSON under userData (trusted, outside any workspace). The pure
 * helpers (sanitize + off-screen guard) live in window-state-core.ts (unit
 * tested); this module is the thin I/O + electron wiring around them.
 */

export type { WindowState } from './window-state-core';

function stateFile(): string {
  return path.join(app.getPath('userData'), 'window-state.json');
}

/** Read the saved window state (startup). Drops an off-screen position. */
export function loadWindowState(): WindowState {
  let state: WindowState;
  try {
    state = sanitizeWindowState(JSON.parse(readFileSync(stateFile(), 'utf8')));
  } catch {
    return { ...DEFAULT_WINDOW_STATE };
  }
  try {
    const areas = screen.getAllDisplays().map((d) => d.workArea);
    if (!isVisibleOn(state, areas)) return { ...state, x: undefined, y: undefined };
  } catch {
    // screen not ready / unavailable — keep the saved position as-is.
  }
  return state;
}

function writeState(state: WindowState): void {
  try {
    void atomicWriteFile(stateFile(), JSON.stringify(state));
  } catch {
    // Best-effort — a failed write must never break window operations.
  }
}

/**
 * Track a window so its bounds + maximized state are persisted (debounced on
 * resize/move, immediately on maximize toggles and close). Use `getNormalBounds`
 * so a maximized window still records the size to restore to, not the full-screen
 * rect.
 */
export function trackWindowState(win: BrowserWindow): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = (): void => {
    if (win.isDestroyed()) return;
    const maximized = win.isMaximized() || win.isFullScreen();
    const b = win.getNormalBounds();
    writeState({ x: b.x, y: b.y, width: b.width, height: b.height, maximized });
  };
  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 400);
  };
  win.on('resize', schedule);
  win.on('move', schedule);
  win.on('maximize', save);
  win.on('unmaximize', save);
  win.on('enter-full-screen', save);
  win.on('leave-full-screen', save);
  win.on('close', () => {
    if (timer) clearTimeout(timer);
    save();
  });
}
