import { createServer } from 'node:http';
import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/app';
import { openInstrumentFromTask, seedGraph } from './helpers/mission-control';

/**
 * Floating in-page stage toolbar (docs/runtime-agent-absorption-2026-06.md §3.2):
 * an injected pill that starts the element picker via the page bridge. The toolbar
 * lives in the embedded web view (not the React page), so we verify the toggle
 * IPC end-to-end — it returns the new state and the page stays healthy (still
 * capturable) after injection/removal.
 *
 * Mission Control summons a browser as a full-area instrument from a task's
 * Resources rather than a persistent stage. The web view must be the VISIBLE
 * instrument before navigate/capture/stage-toolbar act on it (an IPC-created tab
 * alone is hidden, so capture returns null). So we seed a url-resource task that
 * points at the local server and open it as the web instrument, then drive the
 * navigate + capture + stage-toolbar IPC against the now-active view.
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
    // Seed a task whose only Resource is the local page, then summon it as the
    // full-area web instrument so the view is visible/active (capturable).
    await seedGraph(page, {
      tasks: [{ id: 't1', title: 'Inspect the page', outputs: [{ id: 'r1', kind: 'url', uri: url, label: 'page' }] }],
    });
    await openInstrumentFromTask(page, 't1', 'page');

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
