import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/app';

// Bug fix: tiling two DISTINCT tabs surfaces them as one merged "Split view
// group" in the strip, and the group carries an "Exit split view" control that
// collapses back to the single view.
test('split: tiling shows a strip group; exit collapses it', async () => {
  const { app, page } = await launchApp();
  try {
    // Make the two tabs distinct kinds: convert the New Tab to a terminal, then
    // add a fresh New Tab to drag.
    await page.getByRole('button', { name: /Shell in a tab/ }).click();
    await expect(page.getByRole('tab', { name: /Terminal/ })).toBeVisible();
    await page.getByRole('button', { name: 'New tab' }).click();
    await expect(page.getByRole('tab')).toHaveCount(2);

    // Active = terminal; drag the New Tab onto the right of the stage → a split.
    await page.getByRole('tab', { name: /Terminal/ }).click();
    const box = await page.getByRole('main').boundingBox();
    if (!box) throw new Error('stage has no box');
    await page.getByRole('tab', { name: /New Tab/ }).hover();
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, {
      steps: 12,
    });
    await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.5, {
      steps: 12,
    });
    await page.mouse.up();

    // The split is live and the strip brackets the two tabs as a group.
    await expect(page.getByRole('separator')).toHaveCount(1);
    await expect(
      page.getByRole('group', { name: 'Split view group' }),
    ).toBeVisible();

    // Exit the split from the strip → grid collapses (no divider, no group).
    await page.getByRole('button', { name: 'Exit split view' }).click();
    await expect(page.getByRole('separator')).toHaveCount(0);
    await expect(
      page.getByRole('group', { name: 'Split view group' }),
    ).toHaveCount(0);
  } finally {
    await app.close();
  }
});
