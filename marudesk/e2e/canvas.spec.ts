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

    // The minimap is shown by default; its control toggles it.
    await expect(page.getByRole('button', { name: 'Hide minimap' })).toBeVisible();

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

test('canvas: cards can be wired together with a connection, then disconnected', async () => {
  const { app, page } = await launchApp({ surface: 'canvas' });
  try {
    // Two cards, both brought on-screen so their boxes are hittable.
    await page.getByRole('button', { name: 'New card' }).click();
    const cards = page.locator('[data-canvas-card]');
    await expect(cards).toHaveCount(2);
    await page.getByRole('button', { name: 'Fit to content' }).click();

    // Drag from the first card's connection port onto the second card.
    const port = page.getByRole('button', { name: 'Connect to another card' }).first();
    const pb = await port.boundingBox();
    const c2 = await cards.nth(1).boundingBox();
    if (!pb || !c2) throw new Error('missing bounding boxes');
    await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2);
    await page.mouse.down();
    await page.mouse.move(c2.x + c2.width / 2, c2.y + c2.height / 2, { steps: 10 });
    await page.mouse.up();

    // An edge now exists and is auto-selected (its remove control shows).
    await expect(page.locator('[data-edge-id]')).toHaveCount(1);
    const remove = page.getByRole('button', { name: 'Remove connection' });
    await expect(remove).toBeVisible();
    await page.screenshot({ path: 'test-results/maru-canvas-edges.png' });
    await remove.click();
    await expect(page.locator('[data-edge-id]')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('canvas: right-click opens context menus (canvas + card)', async () => {
  const { app, page } = await launchApp({ surface: 'canvas' });
  try {
    const canvas = page.locator('[aria-label="Canvas"]');
    const cb = await canvas.boundingBox();
    if (!cb) throw new Error('no canvas box');

    // Right-click empty canvas → the canvas menu.
    await page.mouse.click(cb.x + cb.width * 0.5, cb.y + cb.height * 0.82, { button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Fit to content' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'New terminal' })).toBeVisible();
    await page.screenshot({ path: 'test-results/maru-canvas-contextmenu.png' });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menuitem', { name: 'Fit to content' })).toHaveCount(0);

    // Right-click a card header → the card menu.
    const header = page.locator('[data-card-header]').first();
    const hb = await header.boundingBox();
    if (!hb) throw new Error('no header box');
    await page.mouse.click(hb.x + hb.width * 0.3, hb.y + hb.height / 2, { button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Bring to front' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Close card' })).toBeVisible();
    await page.keyboard.press('Escape');
  } finally {
    await app.close();
  }
});

test('canvas: a card shrunk to ~minimum stays clamped and keeps its chrome', async () => {
  const { app, page } = await launchApp({ surface: 'canvas' });
  try {
    const card = page.locator('[data-canvas-card]').first();
    const handle = page.getByRole('separator', { name: 'Resize card' }).first();
    const hb = await handle.boundingBox();
    if (!hb) throw new Error('no resize handle');
    // Drag the corner well past the minimum to exercise the small-card layout.
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x - 320, hb.y - 180, { steps: 12 });
    await page.mouse.up();

    await page.screenshot({ path: 'test-results/maru-canvas-smallcard.png' });

    const cb = await card.boundingBox();
    if (!cb) throw new Error('no card box');
    expect(cb.width).toBeLessThan(360); // clamped to CARD_MIN, not collapsed to 0
    await expect(page.getByRole('button', { name: 'Close card' }).first()).toBeVisible();
  } finally {
    await app.close();
  }
});

test('canvas: a card can be resized by its corner handle', async () => {
  const { app, page } = await launchApp({ surface: 'canvas' });
  try {
    const card = page.locator('[data-canvas-card]').first();
    const before = await card.boundingBox();
    const handle = page.getByRole('separator', { name: 'Resize card' }).first();
    const hb = await handle.boundingBox();
    if (!before || !hb) throw new Error('missing bounding boxes');
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + 140, hb.y + 100, { steps: 8 });
    await page.mouse.up();
    const after = await card.boundingBox();
    if (!after) throw new Error('missing bounding box');
    expect(after.width).toBeGreaterThan(before.width + 60);
    expect(after.height).toBeGreaterThan(before.height + 40);
  } finally {
    await app.close();
  }
});
