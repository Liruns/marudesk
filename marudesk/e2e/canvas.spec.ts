import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/app';

/**
 * Maru's infinite-canvas surface, integrated into the Shell as the default stage
 * (the classic tab strip / split grid is one toggle away). Verifies the canvas
 * renders open tabs as cards alongside the normal IDE chrome, that new tabs
 * appear as cards, and that the activity-bar toggle swaps to the classic shell
 * and back. See docs/maru-identity-and-canvas-design.md.
 */
test('canvas: default surface renders cards and toggles to/from classic', async () => {
  const { app, page } = await launchApp({ surface: 'canvas' });
  try {
    // Canvas is the stage centre: its viewport controls + the open tab as a card
    // are present (the canvas replaces the tab strip — cards are the tabs).
    await expect(page.getByRole('button', { name: 'Fit to content' })).toBeVisible();
    const cards = page.getByRole('button', { name: 'Close card' });
    await expect(cards.first()).toBeVisible();
    const initial = await cards.count();
    expect(initial).toBeGreaterThanOrEqual(1);

    // The canvas "New card" affordance adds a card.
    await page.getByRole('button', { name: 'New card' }).click();
    await expect(cards).toHaveCount(initial + 1);

    await page.screenshot({ path: 'test-results/maru-canvas-shell.png' });

    // Toggle to the classic shell — the canvas controls vanish and the tab strip
    // returns (WorkspaceStage owns the strip).
    await page.getByRole('button', { name: 'Switch to classic view' }).click();
    await expect(page.getByRole('button', { name: 'Fit to content' })).toHaveCount(0);
    await expect(page.getByRole('tab').first()).toBeVisible();

    // Toggle back to the canvas.
    await page.getByRole('button', { name: 'Switch to canvas' }).click();
    await expect(page.getByRole('button', { name: 'Fit to content' })).toBeVisible();
  } finally {
    await app.close();
  }
});
