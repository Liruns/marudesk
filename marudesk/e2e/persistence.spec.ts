import { test, expect } from '@playwright/test';
import { launchApp, makeTempUserDataDir } from './helpers/app';
import { runCommand } from './helpers/mission-control';

// Exercises the full persistence path: settings:set → atomicWriteFile to
// userData → reload on the next launch (+ the pre-paint theme guard).
//
// Mission Control has no activity bar / menu, so Settings is summoned as an
// instrument from the ⌘K command palette. The theme picker (Appearance is the
// default Settings category) is a Segmented radiogroup, so the "Light" option
// is still a role="radio" with that accessible name.
test('settings: theme choice persists across a restart', async () => {
  const userDataDir = makeTempUserDataDir();

  // First launch — switch to Light.
  {
    const { app, page } = await launchApp({ userDataDir });
    try {
      await runCommand(page, 'Open Settings');
      await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
      await page.getByRole('radio', { name: 'Light' }).click();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
        .toBe('light');
    } finally {
      await app.close();
    }
  }

  // Second launch, same userData — the choice should be restored.
  {
    const { app, page } = await launchApp({ userDataDir });
    try {
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
        .toBe('light');
    } finally {
      await app.close();
    }
  }
});
