import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/app';

/**
 * The tab switcher palette (Ctrl/Cmd+Shift+A) used to only `activateTab` in main
 * and — outside the legacy canvas — leave the Shell rendering the work graph. In
 * Mission Control that meant the picked tab never showed: a web view painted over
 * the graph with no chrome, or a feature tab showed nothing at all. The palette
 * must now also host the chosen tab as the full-area instrument, mirroring the
 * ⌘K command palette's openInstrument path.
 */
test('tab palette hosts the picked tab as a Mission Control instrument', async () => {
  const { app, page } = await launchApp();
  try {
    // Seed two web tabs straight through the tabs IPC — NOT via the instrument
    // store — so they exist while the Shell is still on the work graph (no tab is
    // hosted). This is the exact gap the fix closes: a picked-but-unhosted tab.
    const ids = await page.evaluate(async () => {
      const a = await window.marudesk.invoke('browser:tabs-new', {
        kind: 'web',
        url: 'about:blank',
      });
      const b = await window.marudesk.invoke('browser:tabs-new', {
        kind: 'web',
        url: 'about:blank',
      });
      return { a, b };
    });
    expect(typeof ids.a).toBe('string');
    expect(typeof ids.b).toBe('string');

    // The work graph is the home — no instrument is hosted yet.
    await expect(page.locator('[data-stage="workgraph"]')).toBeVisible();

    // Open the tab switcher.
    await page.keyboard.press('Control+Shift+A');
    const dialog = page.getByRole('dialog', { name: 'Search tabs' });
    await expect(dialog).toBeVisible();

    // Filter to the seeded web tabs. Typing also waits out the `browser:tabs-new`
    // coalesced push: the palette renders from the RENDERER tab store, which is
    // populated asynchronously after the IPC resolves, so the matching row only
    // appears once the seeded tabs have actually propagated. Asserting the row is
    // visible before pressing Enter makes the pick deterministic (no empty-results
    // race where Enter would be a no-op).
    await page.keyboard.type('blank');
    await expect(dialog.getByText('about:blank').first()).toBeVisible();

    // Enter picks the highlighted (first) row — guaranteed to be a web tab.
    await page.keyboard.press('Enter');

    // The picked web tab is now hosted as the full-area instrument (it was
    // invisible before the fix), and the "← Graph" back affordance is present.
    await expect(page.getByText('Instrument · web')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Graph' })).toBeVisible();
  } finally {
    await app.close();
  }
});
