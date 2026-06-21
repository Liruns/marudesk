import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/app';
import { runCommand } from './helpers/mission-control';

/**
 * The ⌘K command palette re-homes the surfaces the redesign deleted from the rails
 * (Explorer / Search / Source Control). Each opens as a full-area instrument; this
 * verifies they are reachable and mount without crashing (the InstrumentStage
 * header confirms the kind; the panel's complementary region confirms it rendered).
 * openInstrument closes the previous instrument, so the commands chain directly.
 */
test('command palette opens the Files, Search, and Source Control instruments', async () => {
  const { app, page } = await launchApp();
  try {
    await runCommand(page, 'Open Files');
    await expect(page.getByText('Instrument · files')).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Explorer' })).toBeVisible();

    await runCommand(page, 'Search in Files');
    await expect(page.getByText('Instrument · search')).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Search' })).toBeVisible();
    await expect(page.getByPlaceholder('Search in files')).toBeVisible();

    await runCommand(page, 'Source Control');
    await expect(page.getByText('Instrument · sourceControl')).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Source Control' })).toBeVisible();

    // "← Graph" returns to the Task graph home.
    await page.getByRole('button', { name: 'Graph' }).click();
    await expect(page.locator('[data-stage="workgraph"]')).toBeVisible();
  } finally {
    await app.close();
  }
});
