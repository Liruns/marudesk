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

    // No grid yet: no divider. Scope to <main> so the Explorer resize handle
    // (also role="separator", but a sibling of <main>) isn't counted.
    await expect(page.getByRole('main').getByRole('separator')).toHaveCount(0);

    const box = await page.getByRole('main').boundingBox();
    if (!box) throw new Error('stage has no box');

    // The newly-added 2nd tab is active (it's the one on the stage). A split
    // needs two DISTINCT tabs, so drag the OTHER (non-active) tab onto the stage
    // — dragging the active tab onto its own stage is intentionally a no-op now
    // (the "one tab, why is it split?" self-split bug). Drop toward the right
    // edge → a row split placing the dropped tab on the right.
    await page.getByRole('tab').nth(0).hover();
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, {
      steps: 12,
    });
    await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.5, {
      steps: 12,
    });
    await page.mouse.up();

    // The grid is now active: one divider between two tiled panes.
    await expect(page.getByRole('main').getByRole('separator')).toHaveCount(1);
    await expect(page.getByLabel('Grid pane')).toHaveCount(2);
  } finally {
    await app.close();
  }
});

// Regression: closing one tab of a 2-pane split must collapse the grid back to
// the single surviving tab — NOT crash. The dissolve path activates the survivor,
// whose store write used to re-fire the orphan-prune subscription while the group
// was still present, recursing closePane → activateTab → … into a stack overflow
// that blanked/froze the whole window ("close a browser tab in a split → black
// screen, can't do anything"). The orphan sweep is now gated on the tab set, so
// this runs once and the app stays live.
test('grid: closing one tab of a split collapses to a single tab without freezing', async () => {
  const { app, page } = await launchApp();
  try {
    // Two distinct tabs: a terminal (A) + a New Tab (B), then split them.
    await page.getByRole('button', { name: /Shell in a tab/ }).click();
    await expect(page.getByRole('tab', { name: /Terminal/ })).toBeVisible();
    await page.getByRole('button', { name: 'New tab' }).click();
    await expect(page.getByRole('tab')).toHaveCount(2);

    await page.getByRole('tab', { name: /Terminal/ }).click();
    const box = await page.getByRole('main').boundingBox();
    if (!box) throw new Error('stage has no box');
    await page.getByRole('tab', { name: /New Tab/ }).hover();
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 12 });
    await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.5, { steps: 12 });
    await page.mouse.up();

    // Split is live: one divider, two panes.
    await expect(page.getByRole('main').getByRole('separator')).toHaveCount(1);
    await expect(page.getByLabel('Grid pane')).toHaveCount(2);

    // Close the New Tab from the strip → the group dissolves to the lone terminal.
    await page.getByRole('tab', { name: /New Tab/ }).hover();
    await page
      .getByRole('tab', { name: /New Tab/ })
      .getByRole('button', { name: 'Close tab' })
      .click();

    // Collapsed cleanly: no divider, the terminal is the only tab — and the app
    // is still responsive (a crash here would hang these assertions).
    await expect(page.getByRole('main').getByRole('separator')).toHaveCount(0);
    await expect(page.getByRole('tab')).toHaveCount(1);
    await expect(page.getByRole('tab', { name: /Terminal/ })).toBeVisible();

    // Prove the renderer didn't die: the New Tab button still mints a tab.
    await page.getByRole('button', { name: 'New tab' }).click();
    await expect(page.getByRole('tab')).toHaveCount(2);
  } finally {
    await app.close();
  }
});

// Regression: a split is a PERSISTENT group, not transient view state. Visiting
// another (ungrouped) tab hides the grid but must NOT destroy it — returning to
// a grouped tab restores the split intact, and the strip's merged "Split view
// group" bracket stays visible the whole time. (This was the reported bug: the
// split vanished after switching tabs.)
test('grid: a split survives switching to another tab and back', async () => {
  const { app, page } = await launchApp();
  try {
    // Three distinct tabs: a terminal (A) + two New Tab pages (B, C).
    await page.getByRole('button', { name: /Shell in a tab/ }).click();
    await expect(page.getByRole('tab', { name: /Terminal/ })).toBeVisible();
    await page.getByRole('button', { name: 'New tab' }).click();
    await page.getByRole('button', { name: 'New tab' }).click();
    await expect(page.getByRole('tab')).toHaveCount(3);

    // Split the terminal (A) with the first New Tab (B) by dragging it right.
    await page.getByRole('tab', { name: /Terminal/ }).click();
    const box = await page.getByRole('main').boundingBox();
    if (!box) throw new Error('stage has no box');
    await page.getByRole('tab', { name: /New Tab/ }).first().hover();
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 12 });
    await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.5, { steps: 12 });
    await page.mouse.up();

    // Split is live + bracketed in the strip.
    await expect(page.getByRole('main').getByRole('separator')).toHaveCount(1);
    await expect(page.getByRole('group', { name: 'Split view group' })).toBeVisible();

    // Switch to the standalone third tab (C): the grid is HIDDEN (no divider)…
    await page.getByRole('tab').nth(2).click();
    await expect(page.getByRole('main').getByRole('separator')).toHaveCount(0);
    // …but the group is NOT destroyed — its strip bracket stays put.
    await expect(page.getByRole('group', { name: 'Split view group' })).toBeVisible();

    // Back to the grouped terminal tab → the split is restored intact.
    await page.getByRole('tab', { name: /Terminal/ }).click();
    await expect(page.getByRole('main').getByRole('separator')).toHaveCount(1);
    await expect(page.getByLabel('Grid pane')).toHaveCount(2);
  } finally {
    await app.close();
  }
});
