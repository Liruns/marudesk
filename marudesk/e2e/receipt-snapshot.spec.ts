import { createServer } from 'node:http';
import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/app';
import { openInstrumentFromTask, seedGraph } from './helpers/mission-control';

/**
 * Session-receipt running-app snapshot (docs/runtime-agent-absorption-2026-06.md
 * §L2). The ReceiptCard captures the live page on demand via
 * browser:capture-page-data — kept out of the agent snapshot/persistence to avoid
 * base64 bloat. The embedded web view isn't reachable from the React page, so we
 * verify the capture IPC end-to-end (returns a PNG data URL for a painted web
 * tab, null when there's no web view).
 *
 * Mission Control has no tab strip: a web view only gets bounds + paints once it
 * is the active full-area instrument. So we seed a task carrying a url resource and
 * summon it as a web instrument (which activates + shows the live WebContentsView),
 * which is what makes capturePage return a frame. A tab created via IPC alone stays
 * hidden, so capture is null until the instrument is on screen.
 */
test('receipt: capture-page-data returns a PNG data URL for a web tab', async () => {
  const fixture = await startPageFixture();
  const { app, page } = await launchApp();
  try {
    await seedGraph(page, {
      tasks: [
        {
          id: 't1',
          title: 'Capture the live page',
          outputs: [{ id: 'r1', kind: 'url', uri: fixture.url, label: 'Captured page' }],
        },
      ],
    });

    // No web view yet → null.
    const before = await page.evaluate(() =>
      window.marudesk.invoke('browser:capture-page-data'),
    );
    expect(before).toBeNull();

    // Summon the task's url resource as a full-area web instrument: this creates,
    // activates, and SHOWS the live WebContentsView (capturePage is empty until the
    // view has bounds + a painted frame).
    await openInstrumentFromTask(page, 't1', 'Captured page');
    await page.evaluate((url) => window.marudesk.invoke('browser:navigate', url), fixture.url);

    // capturePage can be empty for a frame or two after layout; poll briefly.
    await expect
      .poll(
        async () => {
          const res = await page.evaluate(() =>
            window.marudesk.invoke('browser:capture-page-data'),
          );
          return res ? (res as { dataUrl: string }).dataUrl.slice(0, 22) : null;
        },
        { timeout: 10_000, intervals: [300, 600, 1000] },
      )
      .toBe('data:image/png;base64,');
  } finally {
    await fixture.close();
    await app.close();
  }
});

async function startPageFixture(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><meta charset="utf-8"><body style="background:#123456;color:#fff">marudesk</body>');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not bind a TCP port');
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
