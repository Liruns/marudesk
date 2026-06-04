import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/app';

test('settings: opens as a tab; theme + zoom apply live', async () => {
  const { app, page } = await launchApp();
  try {
    // Gear → context menu → Settings tab.
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
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
    // Given: the Settings tab is open on its default (Appearance) category.
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
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

test('settings: Ctrl/Cmd+, opens the Settings tab', async () => {
  const { app, page } = await launchApp();
  try {
    // Given: the app is focused on the default shell (no editor open).
    await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();

    // When: the user presses the open-settings accelerator.
    await page.keyboard.press('Control+Comma');

    // Then: the Settings tab opens.
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('settings: about exposes GitHub and update controls', async () => {
  const { app, page } = await launchApp();
  try {
    // Given: the Settings tab is open.
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();

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
