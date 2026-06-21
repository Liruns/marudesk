import { createServer, type Server } from 'node:http';
import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/app';
import { openInstrumentFromTask, seedGraph } from './helpers/mission-control';

/**
 * Runtime evidence timeline (docs/runtime-agent-absorption-2026-06.md §3.3). The
 * Timeline panel merges console errors + failed/4xx-5xx network requests from the
 * live page (real CDP) and offers the Fix/Triage actions inline.
 *
 * Mission Control has no tab strip: a web view is reached by summoning a task's
 * url resource as a full-area instrument (openInstrumentFromTask), which makes the
 * WebContentsView the visible/active tab so browser:navigate drives it. We seed a
 * url-resource task, open the instrument, open the DevTools dock + Timeline panel,
 * then navigate to a fixture page (console.error + a 500 fetch) and assert the
 * panel renders that real evidence with its actions.
 */
test('timeline: surfaces a console error + a failed request with actions', async () => {
  const fixture = await startTimelineFixture();
  const { app, page } = await launchApp();
  try {
    // Seed a task whose only output is a url resource; its chip summons a web
    // instrument (a real, visible WebContentsView) — the surface the Timeline
    // panel observes. The resource points at the fixture's blank landing page so
    // the deferred error doesn't fire before the Timeline panel mounts; we
    // navigate to /go (which fires it) below.
    await seedGraph(page, {
      tasks: [
        {
          id: 't1',
          title: 'Inspect the running page',
          outputs: [{ id: 'r1', kind: 'url', uri: fixture.url, label: 'Live page' }],
        },
      ],
    });
    await openInstrumentFromTask(page, 't1', 'Live page');

    const wrench = page.getByRole('button', { name: 'Toggle DevTools (F12)' });
    await expect(wrench).toBeVisible();
    await wrench.click();

    const dock = page.getByLabel('DevTools', { exact: true });
    await expect(dock).toBeVisible();

    // Select the Timeline panel — opening it enables Runtime/Log/Network so both
    // console errors and request failures are captured.
    await dock.getByRole('button', { name: 'Timeline', exact: true }).click();
    await expect(dock.getByText('Runtime evidence', { exact: true })).toBeVisible();

    // Navigate the active instrument to the page that logs an error and fires a
    // request that 500s (deferred, so the Timeline is mounted first).
    await page.evaluate((url) => window.marudesk.invoke('browser:navigate', url), `${fixture.url}go`);

    // Console error row + its Fix action.
    await expect(dock.getByText('marudesk-e2e-timeline')).toBeVisible();
    await expect(dock.getByRole('button', { name: 'Fix this' }).first()).toBeVisible();

    // Failed-request row (500) + its Triage action.
    await expect(dock.getByText('/api/boom')).toBeVisible();
    await expect(dock.getByRole('button', { name: 'Triage' }).first()).toBeVisible();

    // Source filter: "Actions" hides the problem rows (no agent ran in this test,
    // so the agent page-action log is empty); "Problems" brings them back.
    await dock.getByRole('button', { name: 'Actions', exact: true }).click();
    await expect(dock.getByText('No agent page actions on this page yet.')).toBeVisible();
    await dock.getByRole('button', { name: 'Problems', exact: true }).click();
    await expect(dock.getByText('marudesk-e2e-timeline')).toBeVisible();
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
    if (req.url === '/go') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html>
      <meta charset="utf-8">
      <script>
        setTimeout(() => {
          console.error('marudesk-e2e-timeline');
          fetch('/api/boom').catch(() => {});
        }, 300);
      </script>`);
      return;
    }
    // Blank landing page so the instrument can open WITHOUT firing the deferred
    // error before the Timeline panel mounts; the test navigates to /go after.
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><meta charset="utf-8"><body></body>');
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
