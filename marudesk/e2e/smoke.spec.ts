import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/app';

/**
 * Shell smoke test for Mission Control — the Task graph is the app's only home
 * (docs/mission-control-redesign.md). The classic tab strip and activity bar are
 * gone, so the steady-state shell is just the window chrome plus the Task graph
 * stage. A fresh launch with no instrument open renders the graph home directly,
 * so no graph needs to be seeded to prove the shell mounted.
 */

test('app launches and renders the shell', async () => {
  const { app, page } = await launchApp();
  try {
    // The frameless title bar (drag region) is the window chrome.
    await expect(page.getByRole('banner', { name: 'Window chrome' })).toBeVisible();
    // The Task graph stage is the home surface the shell opens on.
    await expect(page.locator('[data-stage="workgraph"]')).toBeVisible();
  } finally {
    await app.close();
  }
});
