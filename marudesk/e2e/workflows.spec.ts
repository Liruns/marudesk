import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/app';

/**
 * Cached browser workflows (docs/runtime-agent-absorption-2026-06.md §3.10/§3.12):
 * a saved page-action sequence replayed WITHOUT the model via the existing
 * interaction-tool executors. We verify the full loop end-to-end — save a
 * fill+click workflow, then run it against a fixture form and observe the
 * server-side side effect the click produces (proving the actions really
 * replayed in the live page).
 */
test('workflows: save then replay fill+click against the live page', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'marudesk-wf-'));
  const fixture = await startFormFixture();
  const { app, page } = await launchApp();
  try {
    await page.evaluate(
      (root) =>
        window.marudesk.invoke('workspaces:create', {
          name: 'WF',
          roots: [{ name: 'Root', path: root }],
        }),
      ws,
    );

    // Open a web tab on the form so save captures it as the replay start URL.
    await page.evaluate(() => window.marudesk.invoke('browser:tabs-new', { kind: 'web' }));
    await expect(page.getByRole('button', { name: 'Toggle DevTools (F12)' })).toBeVisible();
    await page.evaluate((url) => window.marudesk.invoke('browser:navigate', url), fixture.url);
    // Wait for the page to actually commit/paint (navigate resolves before the URL
    // settles on a fresh tab) so save captures the fixture as the start URL.
    await expect
      .poll(() => page.evaluate(() => window.marudesk.invoke('browser:capture-page-data')), {
        timeout: 10_000,
      })
      .not.toBeNull();

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
    fs.rmSync(ws, { recursive: true, force: true });
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
