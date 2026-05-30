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
