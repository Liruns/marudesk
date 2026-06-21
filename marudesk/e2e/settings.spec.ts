import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/app';
import { runCommand } from './helpers/mission-control';

/**
 * Settings. Mission Control is the only home, so Settings is summoned as a
 * full-area instrument from the ⌘K command palette ('Open Settings') — there is
 * no tab strip / activity bar / gear menu to open it from. Once open it is the
 * same SettingsView, so the theme/palette/zoom, cross-category search, Plugins,
 * and About assertions are unchanged; only the entry point moved.
 */

test('settings: opens as an instrument; theme + zoom apply live', async () => {
  const { app, page } = await launchApp();
  try {
    // ⌘K → Open Settings opens the Settings instrument.
    await runCommand(page, 'Open Settings');
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

    // Theme flips the documentElement data-theme.
    await page.getByRole('radio', { name: 'Light' }).click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
      .toBe('light');
    await page.getByRole('radio', { name: 'Dark' }).click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
      .toBe('dark');

    // Theme palette flips the documentElement data-palette; named palettes set
    // the attribute, while Graphite (the default) clears it back to the base tokens.
    await page.getByRole('button', { name: 'Midnight' }).click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.palette))
      .toBe('midnight');
    await page.getByRole('button', { name: 'Carbon' }).click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.palette))
      .toBe('graphite');
    await page.getByRole('button', { name: 'Graphite' }).click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.palette))
      .toBeUndefined();

    // Interface zoom scales the root font-size (rem anchor).
    await page.getByRole('button', { name: 'Increase Interface zoom' }).click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          parseFloat(document.documentElement.style.fontSize || '16'),
        ),
      )
      .toBeGreaterThan(16);
  } finally {
    await app.close();
  }
});

test('settings: search jumps to an individual setting in another category', async () => {
  const { app, page } = await launchApp();
  try {
    // Given: the Settings instrument is open on its default (Appearance) category.
    await runCommand(page, 'Open Settings');
    await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible();

    // When: the user searches for a control that lives in another category.
    await page.getByPlaceholder('Search settings').fill('shell');

    // Then: the result surfaces and clicking it lands on the owning category.
    const result = page.getByRole('button', { name: 'Default shell' });
    await expect(result).toBeVisible();

    // And: a category-level synonym (not any setting's own label) still finds
    // that category's settings.
    await page.getByPlaceholder('Search settings').fill('database');
    await expect(
      page.getByRole('button', { name: 'Save AI Chat sessions' }),
    ).toBeVisible();

    // Clicking a result jumps to the owning category.
    await page.getByPlaceholder('Search settings').fill('shell');
    await page.getByRole('button', { name: 'Default shell' }).click();
    await expect(page.getByRole('heading', { name: 'Terminal' })).toBeVisible();
    await expect(page.getByText('Default shell', { exact: true })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('settings: Ctrl/Cmd+, opens the Settings instrument', async () => {
  const { app, page } = await launchApp();
  try {
    // Given: the app is at its Mission Control home (no instrument open).
    await expect(page.getByRole('button', { name: 'Command palette' })).toBeVisible();

    // When: the user presses the open-settings accelerator.
    await page.keyboard.press('Control+Comma');

    // Then: the Settings instrument opens.
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('settings: Plugins open-folder button invokes the install-folder handler', async () => {
  const { app, page } = await launchApp();
  try {
    await app.evaluate(({ ipcMain }) => {
      const g = globalThis as typeof globalThis & { __pluginsOpenFolderCalls?: number };
      g.__pluginsOpenFolderCalls = 0;
      ipcMain.removeHandler('plugins:open-folder');
      ipcMain.handle('plugins:open-folder', () => {
        g.__pluginsOpenFolderCalls = (g.__pluginsOpenFolderCalls ?? 0) + 1;
        return { path: 'C:\\fake\\plugins' };
      });
    });

    await runCommand(page, 'Open Settings');
    await page.getByRole('button', { name: 'Plugins' }).click();
    await expect(page.getByRole('heading', { name: 'Plugins' })).toBeVisible();
    await page.getByRole('button', { name: 'Open plugins folder' }).click();

    await expect.poll(() =>
      app.evaluate(() => {
        const g = globalThis as typeof globalThis & { __pluginsOpenFolderCalls?: number };
        return g.__pluginsOpenFolderCalls ?? 0;
      }),
    ).toBe(1);
  } finally {
    await app.close();
  }
});

test('settings: about exposes GitHub and update controls', async () => {
  const { app, page } = await launchApp();
  try {
    // Given: the Settings instrument is open.
    await runCommand(page, 'Open Settings');

    // When: the user opens About.
    await page.getByRole('button', { name: 'About' }).click();

    // Then: source and update affordances are available.
    await expect(page.getByRole('heading', { name: 'About' })).toBeVisible();
    await expect(page.getByText('GitHub', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open GitHub' })).toBeVisible();
    await expect(page.getByText('Updates', { exact: true })).toBeVisible();

    // When: the user checks for updates.
    await page.getByRole('button', { name: 'Check' }).click();

    // Then: the check resolves into one of the user-facing release statuses.
    await expect(
      page.getByRole('main').getByText(
        /available on GitHub Releases|latest GitHub release|Could not reach GitHub Releases|No GitHub release has been published|update response this app could not read/,
      ),
    ).toBeVisible({ timeout: 12_000 });
  } finally {
    await app.close();
  }
});
