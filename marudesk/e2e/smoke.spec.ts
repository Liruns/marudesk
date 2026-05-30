import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/app';

test('app launches and renders the shell', async () => {
  const { app, page } = await launchApp();
  try {
    // The frameless title bar (drag region) is the window chrome.
    await expect(page.getByRole('banner', { name: 'Window chrome' })).toBeVisible();
    // The app opens on a home tab, so the strip has at least one tab.
    await expect(page.getByRole('tab').first()).toBeVisible();
    // The activity bar's Settings entry is present.
    await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();
  } finally {
    await app.close();
  }
});
