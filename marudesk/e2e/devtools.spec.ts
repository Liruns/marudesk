import { createServer, type Server } from 'node:http';
import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/app';
import { dock, openInstrumentFromTask, seedGraph } from './helpers/mission-control';

/**
 * DevTools dock smoke. The embedded web view (and its CDP session) is a separate
 * WebContentsView not reachable through the React page under test, so the full
 * Elements/Console/Network flow is a manual GUI check (see the design's §12).
 * This guards the wiring that IS renderer-side: the F12 toggle must no-op when
 * there's no web instrument to inspect, and the wrench/Elements/Console/Network
 * panels behave once a web instrument is summoned.
 *
 * Mission Control: there is no tab strip — a web view is summoned as a full-area
 * instrument from a task's `url` resource. `openInstrumentFromTask` makes that web
 * view the visible/active instrument (required before navigate/capture act on it)
 * and, because it selects the owning task, the per-task dock chat (the composer
 * that DevTools captures feed) stays mounted beside it. The DevTools dock itself
 * lives inside that web instrument (BrowserCanvas), reached via the wrench.
 */

const WEB_TASK = 't_web';

test('devtools: F12 with no web instrument open does not open the dock', async () => {
  const { app, page } = await launchApp();
  try {
    // The home is the Task graph — there is no web page (no instrument) to inspect.
    await seedGraph(page, { tasks: [{ id: 't1', title: 'Plan the work' }] });
    await expect(page.locator('[data-stage="workgraph"]')).toBeVisible();
    const devtools = page.getByLabel('DevTools', { exact: true });
    await expect(devtools).toHaveCount(0);

    await page.keyboard.press('F12');

    // Toggle no-ops with no web instrument: still no dock, and the graph home
    // stage is still alive.
    await expect(devtools).toHaveCount(0);
    await expect(page.locator('[data-stage="workgraph"]')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('devtools: opening the dock on a web instrument renders the live DOM tree', async () => {
  const fixture = await startBlankFixture();
  const { app, page } = await launchApp();
  try {
    // Summon a web instrument from a task's url resource (loads a real DOM).
    await seedGraph(page, {
      tasks: [
        {
          id: WEB_TASK,
          title: 'Inspect the page',
          outputs: [{ id: 'r1', kind: 'url', uri: fixture.url, label: 'Open page' }],
        },
      ],
    });
    await openInstrumentFromTask(page, WEB_TASK, 'Open page');

    // The web toolbar (with the DevTools wrench) appears for a web instrument.
    const wrench = page.getByRole('button', { name: 'Toggle DevTools (F12)' });
    await expect(wrench).toBeVisible();
    await wrench.click();

    // The dock mounts and, once the CDP session attaches and DOM.getDocument
    // resolves, the Elements tree renders real nodes (html/head/body).
    const devtools = page.getByLabel('DevTools', { exact: true });
    await expect(devtools).toBeVisible();
    await expect(devtools.getByRole('treeitem').first()).toBeVisible();

    // The Console lives in the bottom drawer by default (Chrome-style); clicking
    // the Console tab reveals the REPL input.
    await devtools.getByRole('button', { name: 'Console', exact: true }).click();
    await expect(devtools.getByPlaceholder('Evaluate JavaScript')).toBeVisible();
  } finally {
    await fixture.close();
    await app.close();
  }
});

test('devtools: "Add to context" sends the selected node to the dock composer (hook A)', async () => {
  const fixture = await startBlankFixture();
  const { app, page } = await launchApp();
  try {
    await seedGraph(page, {
      tasks: [
        {
          id: WEB_TASK,
          title: 'Capture an element',
          outputs: [{ id: 'r1', kind: 'url', uri: fixture.url, label: 'Open page' }],
        },
      ],
    });
    await openInstrumentFromTask(page, WEB_TASK, 'Open page');
    const wrench = page.getByRole('button', { name: 'Toggle DevTools (F12)' });
    await expect(wrench).toBeVisible();
    await wrench.click();

    const devtools = page.getByLabel('DevTools', { exact: true });
    await expect(devtools).toBeVisible();

    // "Add to context" is disabled until an element is selected.
    const addBtn = page.getByRole('button', { name: 'Add to AI context' });
    await expect(addBtn).toBeDisabled();

    // Select <body> (always an element) → enables the capture button.
    const bodyNode = devtools.getByRole('treeitem').filter({ hasText: 'body' }).first();
    await expect(bodyNode).toBeVisible();
    await bodyNode.click();
    await expect(addBtn).toBeEnabled();

    // Clicking it builds a Capture over real CDP (outerHTML + box model) and adds
    // it to the selected task's dock chat context — confirmed by the success
    // toast and the capture badge on the dock composer.
    await addBtn.click();
    await expect(page.getByText('Added to context')).toBeVisible();
    await expect(dock(page).getByLabel('Agent prompt')).toBeVisible();
    await expect(dock(page).getByLabel('1 capture selected')).toBeVisible();
  } finally {
    await fixture.close();
    await app.close();
  }
});

test('devtools: "Fix this" on a console error sends it to the dock composer (P0)', async () => {
  const fixture = await startBlankFixture();
  const { app, page } = await launchApp();
  try {
    await seedGraph(page, {
      tasks: [
        {
          id: WEB_TASK,
          title: 'Triage a console error',
          outputs: [{ id: 'r1', kind: 'url', uri: fixture.url, label: 'Open page' }],
        },
      ],
    });
    await openInstrumentFromTask(page, WEB_TASK, 'Open page');
    const wrench = page.getByRole('button', { name: 'Toggle DevTools (F12)' });
    await expect(wrench).toBeVisible();
    await wrench.click();

    const devtools = page.getByLabel('DevTools', { exact: true });
    await expect(devtools).toBeVisible();
    await devtools.getByRole('button', { name: 'Console', exact: true }).click();

    // Drive a real console error through CDP via the REPL: console.error fires
    // Runtime.consoleAPICalled(type:'error'), which the relay surfaces as an
    // error row carrying the "Fix this" action.
    const repl = devtools.getByPlaceholder('Evaluate JavaScript');
    await expect(repl).toBeVisible();
    await repl.fill("console.error('marudesk-e2e-boom')");
    await repl.press('Enter');

    const fixBtn = devtools.getByRole('button', { name: 'Fix this' }).first();
    await expect(fixBtn).toBeVisible();
    await fixBtn.click();

    // The error becomes a console-error Capture in the selected task's dock chat
    // context — the toast confirms it, and the dock composer shows the badge.
    await expect(page.getByText('Added to context')).toBeVisible();
    await expect(dock(page).getByLabel('Agent prompt')).toBeVisible();
    await expect(dock(page).getByLabel('1 capture selected')).toBeVisible();
  } finally {
    await fixture.close();
    await app.close();
  }
});

test('devtools: Console starts visible and can move to the bottom drawer', async () => {
  const fixture = await startBlankFixture();
  const { app, page } = await launchApp();
  try {
    await seedGraph(page, {
      tasks: [
        {
          id: WEB_TASK,
          title: 'Use the console',
          outputs: [{ id: 'r1', kind: 'url', uri: fixture.url, label: 'Open page' }],
        },
      ],
    });
    await openInstrumentFromTask(page, WEB_TASK, 'Open page');
    const wrench = page.getByRole('button', { name: 'Toggle DevTools (F12)' });
    await expect(wrench).toBeVisible();
    await wrench.click();

    const devtools = page.getByLabel('DevTools', { exact: true });
    await expect(devtools).toBeVisible();

    const repl = devtools.getByPlaceholder('Evaluate JavaScript');
    const consoleTab = devtools.getByRole('button', { name: 'Console', exact: true });
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
    await fixture.close();
    await app.close();
  }
});

test('devtools: Network separates request payload and pretty JSON response', async () => {
  const fixture = await startNetworkFixture();
  const { app, page } = await launchApp();
  try {
    // Open the fixture as a web instrument (it becomes the visible/active
    // instrument, so browser:navigate acts on it).
    await seedGraph(page, {
      tasks: [
        {
          id: WEB_TASK,
          title: 'Inspect a request',
          outputs: [{ id: 'r1', kind: 'url', uri: fixture.url, label: 'Open page' }],
        },
      ],
    });
    await openInstrumentFromTask(page, WEB_TASK, 'Open page');
    const wrench = page.getByRole('button', { name: 'Toggle DevTools (F12)' });
    await expect(wrench).toBeVisible();
    await wrench.click();

    const devtools = page.getByLabel('DevTools', { exact: true });
    await expect(devtools).toBeVisible();
    await devtools.getByRole('button', { name: 'Network', exact: true }).click();

    // Re-navigate (cache-busting path) so the page reloads and re-fires its
    // delayed fetch while the Network panel is recording.
    await page.evaluate(
      (url) => window.marudesk.invoke('browser:navigate', url),
      `${fixture.url}go`,
    );

    await expect(devtools.getByText('users')).toBeVisible();
    await devtools.getByText('users').click();
    // The detail pane is tabbed (Headers / Response / Timing / …); the request
    // payload renders as a section of the default Headers tab.
    await expect(devtools.getByText('Request payload')).toBeVisible();
    await expect(devtools.getByText('"name": "Ada"')).toBeVisible();
    await expect(devtools.getByText('sk-123456789012345678901234')).toHaveCount(0);

    await devtools.getByRole('button', { name: 'Response', exact: true }).click();
    await devtools.getByRole('button', { name: 'Load response body' }).click();
    await expect(devtools.getByText('"ok": true')).toBeVisible();
    await expect(devtools.getByText('"id": 42')).toBeVisible();
  } finally {
    await fixture.close();
    await app.close();
  }
});

/** A minimal real-DOM page (html/head/body) served over http for the dock tests. */
async function startBlankFixture(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not bind a TCP port');
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => closeServer(server),
  };
}

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
