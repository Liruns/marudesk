import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/app';

/**
 * Boot reveal (v0.2.0 infinite-splash regression). The main window must become
 * ACTUALLY visible — not merely loaded — without depending on `ready-to-show`,
 * which packaged Windows builds can drop entirely for a hidden window (the
 * splash then spins forever). Playwright drives pages over CDP and works fine
 * against a never-shown window, so every other spec passes in that broken
 * state; this one asserts at the BrowserWindow level where the bug lives.
 */

test('boot: main window becomes visible and the splash closes', async () => {
  const { app } = await launchApp();
  try {
    await expect
      .poll(
        () =>
          app.evaluate(({ BrowserWindow }) => {
            const all = BrowserWindow.getAllWindows();
            const main = all.find((w) =>
              w.webContents.getURL().includes('index.html'),
            );
            return {
              mainVisible: main ? main.isVisible() && !main.isMinimized() : false,
              // The bootstrap splash must be gone once the main window is up.
              otherWindows: all.length - (main ? 1 : 0),
            };
          }),
        { timeout: 15_000 },
      )
      .toEqual({ mainVisible: true, otherWindows: 0 });
  } finally {
    await app.close();
  }
});
