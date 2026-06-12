import { createServer, type Server } from 'node:http';
import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/app';

/**
 * DevTools dock smoke. The embedded web view (and its CDP session) is a separate
 * WebContentsView not reachable through the React page under test, so the full
 * Elements/Console/Network flow is a manual GUI check (see the design's §12).
 * This guards the wiring that IS renderer-side: the F12 toggle must no-op on a
 * non-web tab (DevTools attaches to a page) without throwing or mounting a dock.
 */
test('devtools: F12 on a non-web tab does not open the dock', async () => {
  const { app, page } = await launchApp();
  try {
    // The app opens on a home (feature) tab — no web page to inspect.
    await expect(page.getByRole('tab').first()).toBeVisible();
    const dock = page.getByLabel('DevTools', { exact: true });
    await expect(dock).toHaveCount(0);

    await page.keyboard.press('F12');

    // Toggle no-ops on a non-web tab: still no dock, and the shell is alive.
    await expect(dock).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('devtools: opening the dock on a web tab renders the live DOM tree', async () => {
  const { app, page } = await launchApp();
  try {
    // Create + activate a web tab (loads about:blank — enough for a real DOM).
    await page.evaluate(() =>
      window.marudesk.invoke('browser:tabs-new', { kind: 'web' }),
    );

    // The web toolbar (with the DevTools wrench) appears for a web tab.
    const wrench = page.getByRole('button', { name: 'Toggle DevTools (F12)' });
    await expect(wrench).toBeVisible();
    await wrench.click();

    // The dock mounts and, once the CDP session attaches and DOM.getDocument
    // resolves, the Elements tree renders real nodes (html/head/body).
    const dock = page.getByLabel('DevTools', { exact: true });
    await expect(dock).toBeVisible();
    await expect(dock.getByRole('treeitem').first()).toBeVisible();

    // The Console lives in the bottom drawer by default (Chrome-style); Esc
    // opens the drawer (when DevTools has focus), revealing the REPL input.
    await dock.getByRole('button', { name: 'Console', exact: true }).click();
    await expect(dock.getByPlaceholder('Evaluate JavaScript')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('devtools: "Add to context" sends the selected node to the composer (hook A)', async () => {
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

    // "Add to context" is disabled until an element is selected.
    const addBtn = page.getByRole('button', { name: 'Add to AI context' });
    await expect(addBtn).toBeDisabled();

    // Select <body> (always an element) → enables the capture button.
    const bodyNode = dock.getByRole('treeitem').filter({ hasText: 'body' }).first();
    await expect(bodyNode).toBeVisible();
    await bodyNode.click();
    await expect(addBtn).toBeEnabled();

    // Clicking it builds a Capture over real CDP (outerHTML + box model) and
    // adds it to the composer context — confirmed by the success toast.
    await addBtn.click();
    await expect(page.getByText('Added to context')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('devtools: "Fix this" on a console error sends it to the composer (P0)', async () => {
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
    // Console lives in the bottom drawer by default; Esc opens it.
    await dock.getByRole('button', { name: 'Console', exact: true }).click();

    // Drive a real console error through CDP via the REPL: console.error fires
    // Runtime.consoleAPICalled(type:'error'), which the relay surfaces as an
    // error row carrying the "Fix this" action.
    const repl = dock.getByPlaceholder('Evaluate JavaScript');
    await expect(repl).toBeVisible();
    await repl.fill("console.error('marudesk-e2e-boom')");
    await repl.press('Enter');

    const fixBtn = dock.getByRole('button', { name: 'Fix this' }).first();
    await expect(fixBtn).toBeVisible();
    await fixBtn.click();

    // The error becomes a console-error Capture in the composer context.
    await expect(page.getByText('Added to context')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('devtools: Console starts visible and can move to the bottom drawer', async () => {
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

    const repl = dock.getByPlaceholder('Evaluate JavaScript');
    const consoleTab = dock.getByRole('button', { name: 'Console', exact: true });
    await expect(consoleTab).toBeVisible();
    await consoleTab.click();
    await expect(repl).toBeVisible();

    await consoleTab.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Move to bottom' }).click();
    // Moving Console to the drawer keeps the drawer open so the REPL remains
    // discoverable instead of disappearing behind an Esc-only shortcut.
    await expect(repl).toBeVisible();

    await consoleTab.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Move to top' }).click();
    // The move keeps Console available (now in the main bar) — its REPL stays
    // mounted as the active main panel.
    await expect(repl).toBeVisible();
  } finally {
    await app.close();
  }
});

test('devtools: Network separates request payload and pretty JSON response', async () => {
  const fixture = await startNetworkFixture();
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
    await dock.getByRole('button', { name: 'Network', exact: true }).click();

    await page.evaluate((url) => window.marudesk.invoke('browser:navigate', url), fixture.url);

    await expect(dock.getByText('users')).toBeVisible();
    await dock.getByText('users').click();
    // The detail pane is tabbed (Headers / Response / Timing / …); the request
    // payload renders as a section of the default Headers tab.
    await expect(dock.getByText('Request payload')).toBeVisible();
    await expect(dock.getByText('"name": "Ada"')).toBeVisible();
    await expect(dock.getByText('sk-123456789012345678901234')).toHaveCount(0);

    await dock.getByRole('button', { name: 'Response', exact: true }).click();
    await dock.getByRole('button', { name: 'Load response body' }).click();
    await expect(dock.getByText('"ok": true')).toBeVisible();
    await expect(dock.getByText('"id": 42')).toBeVisible();
  } finally {
    await fixture.close();
    await app.close();
  }
});

async function startNetworkFixture(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    if (req.url === '/api/users') {
      req.resume();
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, user: { id: 42, name: 'Ada' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html>
      <meta charset="utf-8">
      <script>
        setTimeout(() => {
          fetch('/api/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: 'Ada',
              api_key: 'sk-123456789012345678901234'
            })
          });
        }, 250);
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
