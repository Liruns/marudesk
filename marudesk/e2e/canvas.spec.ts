import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/app';

/**
 * Phase 2A of the Maru identity overhaul: the infinite-canvas surface
 * (`#/canvas`). Verifies the activity-bar entry opens it, open tabs render as
 * cards, a new card can be created, and the classic tabbed view is reachable
 * again. See docs/maru-identity-and-canvas-design.md.
 */
test('canvas: opens from the activity bar, renders cards, and returns to classic view', async () => {
  const { app, page } = await launchApp();
  try {
    // Classic shell renders the tab strip first.
    await expect(page.getByRole('tab').first()).toBeVisible();

    // Open the infinite canvas from the activity-bar entry.
    await page.getByRole('button', { name: 'Canvas (beta)' }).click();

    // The canvas shell shows the Maru wordmark in its chrome (scoped to the
    // banner so it doesn't collide with the rebranded home card's "Maru" hero)
    // and the open tab as a card (each card header carries a "Close card" control).
    await expect(page.getByRole('banner').getByText('Maru', { exact: true })).toBeVisible();
    const cards = page.getByRole('button', { name: 'Close card' });
    await expect(cards.first()).toBeVisible();
    const initialCount = await cards.count();
    expect(initialCount).toBeGreaterThanOrEqual(1);

    // Create a new browser card; the canvas places it, so the card count grows.
    await page.getByRole('button', { name: 'New browser' }).click();
    await expect(cards).toHaveCount(initialCount + 1);

    // The web card exposes a per-card address bar; it accepts input and submits
    // without error (the live page itself is a native view, not in this DOM).
    const address = page.getByRole('textbox', { name: 'Address' });
    await expect(address.first()).toBeVisible();
    await address.first().fill('example.com');
    await address.first().press('Enter');
    await expect(cards).toHaveCount(initialCount + 1); // still intact after navigate

    // Zoom controls are present.
    await expect(page.getByRole('button', { name: 'Fit to content' })).toBeVisible();

    // Capture the canvas for a visual record of the new surface.
    await page.screenshot({ path: 'test-results/maru-canvas-2a.png' });

    // Back to the classic tabbed view.
    await page.getByRole('button', { name: 'Classic view' }).click();
    await expect(page.getByRole('tab').first()).toBeVisible();
  } finally {
    await app.close();
  }
});
