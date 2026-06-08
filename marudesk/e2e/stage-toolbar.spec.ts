import { createServer } from 'node:http';
import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/app';

/**
 * Floating in-page stage toolbar (docs/runtime-agent-absorption-2026-06.md §3.2):
 * an injected pill that starts the element picker via the page bridge. The toolbar
 * lives in the embedded web view (not the React page), so we verify the toggle
 * IPC end-to-end — it returns the new state and the page stays healthy (still
 * capturable) after injection/removal.
 */
test('stage toolbar: toggle injects/removes without breaking the page', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><meta charset="utf-8"><body style="background:#123"><h1>stage</h1></body>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  const url = `http://127.0.0.1:${addr.port}/`;

  const { app, page } = await launchApp();
  try {
    await page.evaluate(() => window.marudesk.invoke('browser:tabs-new', { kind: 'web' }));
    await expect(page.getByRole('button', { name: 'Toggle DevTools (F12)' })).toBeVisible();
    await page.evaluate((u) => window.marudesk.invoke('browser:navigate', u), url);
    await expect
      .poll(() => page.evaluate(() => window.marudesk.invoke('browser:capture-page-data')), {
        timeout: 15_000,
        intervals: [200, 400, 800, 1500],
      })
      .not.toBeNull();

    // Enable → returns true; page still renders (capture non-null).
    expect(await page.evaluate(() => window.marudesk.invoke('browser:stage-toolbar', true))).toBe(true);
    await expect
      .poll(() => page.evaluate(() => window.marudesk.invoke('browser:capture-page-data')), {
        timeout: 15_000,
        intervals: [200, 400, 800, 1500],
      })
      .not.toBeNull();

    // Disable → returns false.
    expect(await page.evaluate(() => window.marudesk.invoke('browser:stage-toolbar', false))).toBe(false);
  } finally {
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
