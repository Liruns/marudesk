import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/app';

test('editor: new untitled file opens dirty in Monaco', async () => {
  const { app, page } = await launchApp();
  try {
    await page.getByRole('button', { name: 'Code editor' }).click();
    // Untitled tab is titled Untitled-1 and reads dirty from creation.
    await expect(page.getByRole('tab', { name: /Untitled-1/ })).toBeVisible();
    await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Unsaved')).toBeVisible();
  } finally {
    await app.close();
  }
});
