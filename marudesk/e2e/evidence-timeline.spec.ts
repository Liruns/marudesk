import { createServer, type Server } from 'node:http';
import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/app';

/**
 * Runtime evidence timeline (docs/runtime-agent-absorption-2026-06.md §3.3). The
 * Timeline panel merges console errors + failed/4xx-5xx network requests from the
 * live page (real CDP) and offers the Fix/Triage actions inline. The embedded web
 * view isn't reachable from the React page, so we drive real evidence through a
 * fixture page (console.error + a 500 fetch) and assert the panel renders it.
 */
test('timeline: surfaces a console error + a failed request with actions', async () => {
  const fixture = await startTimelineFixture();
  const { app, page } = await launchApp();
  try {
    await page.evaluate(() =>
      window.marudesk.invoke('browser:tabs-new', { kind: 'web' }),
    );
    const wrench = page.getByRole('button', { name: 'Toggle DevTools (F12)' });
    await expect(wrench).toBeVisible();
    await wrench.click();

    const dock = page.getByLabel('DevTools', { exact: true });
    await expect(dock).toBeVisible();

    // Select the Timeline panel — opening it enables Runtime/Log/Network so both
    // console errors and request failures are captured.
    await dock.getByRole('button', { name: 'Timeline', exact: true }).click();
    await expect(dock.getByText('Runtime evidence')).toBeVisible();

    // Navigate to a page that logs an error and fires a request that 500s.
    await page.evaluate((url) => window.marudesk.invoke('browser:navigate', url), fixture.url);

    // Console error row + its Fix action.
    await expect(dock.getByText('marudesk-e2e-timeline')).toBeVisible();
    await expect(dock.getByRole('button', { name: 'Fix this' }).first()).toBeVisible();

    // Failed-request row (500) + its Triage action.
    await expect(dock.getByText('/api/boom')).toBeVisible();
    await expect(dock.getByRole('button', { name: 'Triage' }).first()).toBeVisible();
  } finally {
    await fixture.close();
    await app.close();
  }
});

async function startTimelineFixture(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    if (req.url === '/api/boom') {
      req.resume();
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'boom' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html>
      <meta charset="utf-8">
      <script>
        setTimeout(() => {
          console.error('marudesk-e2e-timeline');
          fetch('/api/boom').catch(() => {});
        }, 300);
      </script>`);
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not bind a TCP port');
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => closeServer(server),
  };
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
