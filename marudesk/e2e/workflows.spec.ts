import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/app';
import { openInstrumentFromTask, seedGraph } from './helpers/mission-control';

/**
 * Cached browser workflows (docs/runtime-agent-absorption-2026-06.md §3.10/§3.12):
 * a saved page-action sequence replayed WITHOUT the model via the existing
 * interaction-tool executors. We verify the full loop end-to-end — save a
 * fill+click workflow, then run it against a fixture form and observe the
 * server-side side effect the click produces (proving the actions really
 * replayed in the live page).
 *
 * Mission Control: workflows have no home surface of their own — the save/run/
 * delete loop is driven entirely through IPC. The only UI dependency is a VISIBLE
 * web instrument: `workflows:save` reads the active web view's URL as the replay
 * start point, and `browser:capture-page-data` only returns once that view is
 * actually painting. So we seed a task whose url Resource points at the fixture
 * and summon it as a full-area instrument (which creates + navigates + shows the
 * web view), rather than the (removed) classic tab strip.
 */
test('workflows: save then replay fill+click against the live page', async () => {
  const fixture = await startFormFixture();
  const wsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'marudesk-workflows-'));
  const { app, page } = await launchApp();
  try {
    // workflows:save records the active workspace, so open one first (the removed
    // tab strip used to carry one implicitly).
    await page.evaluate(async (root) => {
      const ws = await window.marudesk.invoke('workspaces:create', {
        name: 'Workflows',
        roots: [{ name: 'Root', path: root }],
      });
      await window.marudesk.invoke('workspaces:set-active', { workspaceId: ws.id });
    }, wsRoot);

    // Seed a task whose Resource is the fixture URL, then summon it as the
    // visible web instrument. openResource creates the web tab WITH that url,
    // activates it, and hosts it as the full-area instrument — so the live view
    // paints (capture is non-null) and is the active tab `workflows:save` reads.
    await seedGraph(page, {
      tasks: [
        {
          id: 't1',
          title: 'Submit the fixture form',
          outputs: [{ id: 'r1', kind: 'url', uri: fixture.url, label: 'Form' }],
        },
      ],
    });
    await openInstrumentFromTask(page, 't1', 'Form');

    // Wait for the active web instrument's URL to settle on the fixture (the tab
    // navigates as it opens, and navigate resolves before the URL commits) so
    // `workflows:save` captures the fixture as the start URL. A URL-settle gate is
    // used instead of capture-page-data — the latter depends on a GPU paint that
    // can transiently error late in a run, and save needs the committed URL anyway.
    await expect
      .poll(
        async () => {
          const snap = await page.evaluate(() => window.marudesk.invoke('browser:tabs-snapshot'));
          return snap.tabs.find((t) => t.id === snap.activeTabId)?.url ?? '';
        },
        { timeout: 10_000 },
      )
      .toContain('127.0.0.1');

    // Save a workflow: fill the name field, then click submit.
    const saved = await page.evaluate(() =>
      window.marudesk.invoke('workflows:save', {
        name: 'Submit form',
        steps: [
          { tool: 'fill', input: { selector: '#name', value: 'replayed' } },
          { tool: 'click', input: { selector: '#go' } },
        ],
      }),
    );
    expect(saved.startUrl).toContain('127.0.0.1');

    const list = await page.evaluate(() => window.marudesk.invoke('workflows:list'));
    expect(list.map((w) => w.id)).toContain(saved.id);

    // Replay it — no model. The runner re-navigates to the start URL, fills, then
    // clicks; the click POSTs the field value back to the fixture server.
    const run = await page.evaluate((id) => window.marudesk.invoke('workflows:run', { id }), saved.id);
    expect(run.ok).toBe(true);
    if (run.ok) expect(run.results.every((r) => r.ok)).toBe(true);

    // The side effect proves the actions hit the live DOM.
    await expect.poll(() => fixture.lastSubmitted(), { timeout: 8_000 }).toBe('replayed');

    // Delete removes it from the list.
    await page.evaluate((id) => window.marudesk.invoke('workflows:delete', { id }), saved.id);
    const after = await page.evaluate(() => window.marudesk.invoke('workflows:list'));
    expect(after.map((w) => w.id)).not.toContain(saved.id);
  } finally {
    await fixture.close();
    await app.close();
    await fs.rm(wsRoot, { recursive: true, force: true });
  }
});

async function startFormFixture(): Promise<{
  url: string;
  lastSubmitted: () => string | null;
  close: () => Promise<void>;
}> {
  let last: string | null = null;
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (u.pathname === '/done') {
      last = u.searchParams.get('name');
      res.writeHead(200).end('ok');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><meta charset="utf-8"><body>
      <input id="name" />
      <button id="go" onclick="fetch('/done?name=' + encodeURIComponent(document.getElementById('name').value))">Go</button>
    </body>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('fixture did not bind a port');
  return {
    url: `http://127.0.0.1:${addr.port}/`,
    lastSubmitted: () => last,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
