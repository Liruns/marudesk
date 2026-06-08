import { createServer, type Server } from 'node:http';
import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/app';

/**
 * Session-receipt running-app snapshot (docs/runtime-agent-absorption-2026-06.md
 * §L2). The ReceiptCard captures the live page on demand via
 * browser:capture-page-data — kept out of the agent snapshot/persistence to avoid
 * base64 bloat. The embedded web view isn't reachable from the React page, so we
 * verify the capture IPC end-to-end (returns a PNG data URL for a painted web
 * tab, null when there's no web view).
 */
test('receipt: capture-page-data returns a PNG data URL for a web tab', async () => {
  const fixture = await startPageFixture();
  const { app, page } = await launchApp();
  try {
    // No web view yet → null.
    const before = await page.evaluate(() =>
      window.marudesk.invoke('browser:capture-page-data'),
    );
    expect(before).toBeNull();

    // Open a web tab and load a painted page (capturePage is empty until the
    // view has bounds + a frame).
    await page.evaluate(() =>
      window.marudesk.invoke('browser:tabs-new', { kind: 'web' }),
    );
    await expect(
      page.getByRole('button', { name: 'Toggle DevTools (F12)' }),
    ).toBeVisible();
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
