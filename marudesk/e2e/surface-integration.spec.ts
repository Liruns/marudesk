import { test, expect, type Page } from '@playwright/test';
import { launchApp, dragCanvasCardHeader } from './helpers/app';

/**
 * Cross-surface integration: the classic split-grid and the infinite canvas are
 * two layouts over ONE shared tab set, so a tab/group/placement made in one must
 * survive a swap to the other (and back). These guard the seams between the tab
 * store, the grid store, and the per-canvas placement/group store.
 */

async function toSurface(page: Page, name: 'Classic' | 'Canvas' | 'Work OS') {
  await page.getByRole('button', { name: /Surface:/ }).click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}

test('surface: the tab set is shared between classic and canvas (close propagates)', async () => {
  const { page, app } = await launchApp({ surface: 'classic' });
  try {
    await page.getByRole('button', { name: 'New tab' }).first().click();
    await expect(page.getByRole('tab')).toHaveCount(2);

    // The same two tabs render as cards on the canvas.
    await toSurface(page, 'Canvas');
    const cards = page.locator('[data-canvas-card]');
    await expect(cards).toHaveCount(2);

    // Closing a card removes the tab everywhere — back in classic it's gone.
    await page.getByRole('button', { name: 'Fit to content' }).click();
    await page.getByRole('button', { name: 'Close card' }).first().click();
    await expect(cards).toHaveCount(1);
    await toSurface(page, 'Classic');
    await expect(page.getByRole('tab')).toHaveCount(1);
  } finally {
    await app.close();
  }
});

test('surface: a canvas placement survives a classic round-trip', async () => {
  const { page, app } = await launchApp({ surface: 'canvas' });
  try {
    await page.getByRole('button', { name: 'New card' }).click();
    const cards = page.locator('[data-canvas-card]');
    await expect(cards).toHaveCount(2);
    await page.getByRole('button', { name: 'Fit to content' }).click();
    await dragCanvasCardHeader(page, 0, 180, 130);

    await toSurface(page, 'Classic');
    await expect(page.getByRole('tab')).toHaveCount(2);
    await toSurface(page, 'Canvas');
    await expect(cards).toHaveCount(2);
    await page.getByRole('button', { name: 'Fit to content' }).click();
    // Both cards are still distinct — the move wasn't discarded when the stage
    // swapped away (a lost placement would collapse them to the default spot).
    const b0 = await cards.nth(0).boundingBox();
    const b1 = await cards.nth(1).boundingBox();
    if (!b0 || !b1) throw new Error('missing boxes');
    expect(Math.hypot(b0.x - b1.x, b0.y - b1.y)).toBeGreaterThan(40);
  } finally {
    await app.close();
  }
});

test('surface: a canvas tab group survives a classic round-trip', async () => {
  const { page, app } = await launchApp({ surface: 'canvas' });
  try {
    await page.getByRole('button', { name: 'New card' }).click();
    const cards = page.locator('[data-canvas-card]');
    await expect(cards).toHaveCount(2);
    await page.getByRole('button', { name: 'Fit to content' }).click();
    const headers = page.locator('[data-card-header]');
    await headers.nth(0).dragTo(headers.nth(1));
    await expect(cards).toHaveCount(1); // merged into one group card
    await expect(page.getByRole('tab')).toHaveCount(2); // its 2-tab strip

    await toSurface(page, 'Classic');
    await toSurface(page, 'Canvas');
    // Still one group card with its 2-tab strip — the group didn't dissolve.
    await expect(cards).toHaveCount(1);
    await expect(page.getByRole('tab')).toHaveCount(2);
  } finally {
    await app.close();
  }
});
