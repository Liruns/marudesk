import { test, expect } from '@playwright/test';
import { launchApp, makeTempUserDataDir } from './helpers/app';

// Exercises the full persistence path: settings:set → atomicWriteFile to
// userData → reload on the next launch (+ the pre-paint theme guard).
test('settings: theme choice persists across a restart', async () => {
  const userDataDir = makeTempUserDataDir();

  // First launch — switch to Light.
  {
    const { app, page } = await launchApp({ userDataDir });
    try {
      await page.getByRole('button', { name: 'Settings' }).click();
      await page.getByRole('menuitem', { name: 'Settings' }).click();
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
