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

    // Panel switching works.
    await dock.getByRole('button', { name: 'Console' }).click();
    await expect(dock.getByPlaceholder('Evaluate JavaScript')).toBeVisible();
  } finally {
    await app.close();
  }
});
