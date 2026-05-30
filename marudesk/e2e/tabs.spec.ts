import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/app';

test('tabs: the new-tab button adds a tab', async () => {
  const { app, page } = await launchApp();
  try {
    await expect(page.getByRole('tab')).toHaveCount(1);
    await page.getByRole('button', { name: 'New tab' }).click();
    await expect(page.getByRole('tab')).toHaveCount(2);
  } finally {
    await app.close();
  }
});
