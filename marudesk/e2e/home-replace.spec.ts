import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/app';

// Bug fix: a launcher click on the New Tab page converts THAT tab in place
// (browser:tabs-replace) instead of opening a second tab beside it.
test('home: launcher converts the New Tab in place (no extra tab)', async () => {
  const { app, page } = await launchApp();
  try {
    await expect(page.getByRole('tab')).toHaveCount(1);

    // The New Tab launcher card for Terminal ("Shell in a tab" is its unique hint).
    await page.getByRole('button', { name: /Shell in a tab/ }).click();

    // Still one tab — converted, not added — and it's now the Terminal tab.
    await expect(page.getByRole('tab')).toHaveCount(1);
    await expect(page.getByRole('tab', { name: /Terminal/ })).toBeVisible();
  } finally {
    await app.close();
  }
});
