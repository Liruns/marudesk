import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/app';

// Phase F: dragging a tab from the strip onto the stage tiles the view into a
// grid. Driven with real mouse events (down → move in steps → up): Chromium
// promotes the draggable tab chip's mouse drag into a native HTML5 drag, so the
// chip's dragstart, the stage overlay's dragover, and its drop all fire exactly
// as in a hand drag — then we assert the split appeared (a draggable divider and
// two tiled panes).
test('grid: dragging a tab onto the stage splits into two panes', async () => {
  const { app, page } = await launchApp();
  try {
    // Start on a single tab; add a second so there are two tabs to tile.
    await expect(page.getByRole('tab')).toHaveCount(1);
    await page.getByRole('button', { name: 'New tab' }).click();
    await expect(page.getByRole('tab')).toHaveCount(2);

    // No grid yet: no divider.
    await expect(page.getByRole('separator')).toHaveCount(0);

    const box = await page.getByRole('main').boundingBox();
    if (!box) throw new Error('stage has no box');

    // Drag the 2nd tab into the stage and toward the right edge → a row split
    // placing the dropped tab on the right.
    await page.getByRole('tab').nth(1).hover();
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, {
      steps: 12,
    });
    await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.5, {
      steps: 12,
    });
    await page.mouse.up();

    // The grid is now active: one divider between two tiled panes.
    await expect(page.getByRole('separator')).toHaveCount(1);
    await expect(page.getByLabel('Grid pane')).toHaveCount(2);
  } finally {
    await app.close();
  }
});
