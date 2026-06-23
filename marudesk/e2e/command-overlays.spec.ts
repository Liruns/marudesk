import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/app';

/**
 * The ⌘K palette can now open the two keyboard-first navigation overlays — Quick
 * Open (Go to File) and the Tab Palette (Switch Tab) — so they're discoverable
 * without knowing the chord. Verifies each command opens its overlay.
 */
test('command palette opens Go to File and Switch Tab', async () => {
  const { app, page } = await launchApp();
  try {
    // Go to File → Quick Open overlay.
    await page.keyboard.press('Control+k');
    await page.keyboard.type('Go to File');
    await page.keyboard.press('Enter');
    await expect(page.getByPlaceholder('Open a folder to search files')).toBeVisible();
    await page.keyboard.press('Escape');

    // Switch Tab → Tab Palette overlay.
    await page.keyboard.press('Control+k');
    await page.keyboard.type('Switch Tab');
    await page.keyboard.press('Enter');
    await expect(page.getByPlaceholder('Search tabs…')).toBeVisible();
  } finally {
    await app.close();
  }
});
