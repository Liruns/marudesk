import { test, expect } from '@playwright/test';
import { launchApp, makeTempUserDataDir } from './helpers/app';

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

    // Drag from the first card's right-edge connection port onto the second card.
    const port = page.getByRole('button', { name: 'Connect from right edge' }).first();
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

test('canvas: a focused card moves with arrow keys and closes with Delete', async () => {
  const { app, page } = await launchApp({ surface: 'canvas' });
  try {
    await page.getByRole('button', { name: 'New card' }).click();
    const cards = page.locator('[data-canvas-card]');
    await expect(cards).toHaveCount(2);
    const card = cards.first();
    const before = await card.boundingBox();
    if (!before) throw new Error('no card box');

    await card.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    const after = await card.boundingBox();
    if (!after) throw new Error('no card box');
    expect(after.x).toBeGreaterThan(before.x);
    expect(after.y).toBeGreaterThan(before.y);

    const closeCount = await page.getByRole('button', { name: 'Close card' }).count();
    await card.focus();
    await page.keyboard.press('Delete');
    await expect(page.getByRole('button', { name: 'Close card' })).toHaveCount(closeCount - 1);
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

test('canvas: dragging a card onto another merges them into a tab group, then pops out', async () => {
  const { app, page } = await launchApp({ surface: 'canvas' });
  try {
    await page.getByRole('button', { name: 'New card' }).click();
    const cards = page.locator('[data-canvas-card]');
    await expect(cards).toHaveCount(2);
    await page.getByRole('button', { name: 'Fit to content' }).click();

    // Drag the first card's header onto the second card's header → merge.
    const headers = page.locator('[data-card-header]');
    const h1 = await headers.nth(0).boundingBox();
    const h2 = await headers.nth(1).boundingBox();
    if (!h1 || !h2) throw new Error('missing header boxes');
    await page.mouse.move(h1.x + h1.width / 2, h1.y + h1.height / 2);
    await page.mouse.down();
    // Move in steps so the drag registers, landing on the target's header band.
    await page.mouse.move(h2.x + h2.width / 2, h2.y + h2.height / 2, { steps: 12 });
    await page.mouse.up();

    // Two cards became one group card with a 2-tab strip.
    await expect(cards).toHaveCount(1);
    await expect(page.getByRole('tab')).toHaveCount(2);
    await page.screenshot({ path: 'test-results/maru-canvas-merge.png' });

    // Pop the active tab back out → two cards again.
    await page.locator('[data-card-header]').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Pop out tab' }).click();
    await expect(cards).toHaveCount(2);
  } finally {
    await app.close();
  }
});

test('canvas: a card can be locked (no move/resize) and maximized', async () => {
  const { app, page } = await launchApp({ surface: 'canvas' });
  try {
    const card = page.locator('[data-canvas-card]').first();
    const before = await card.boundingBox();
    const header = page.locator('[data-card-header]').first();
    const hb = await header.boundingBox();
    if (!before || !hb) throw new Error('missing boxes');
    const hx = hb.x + hb.width * 0.3;
    const hy = hb.y + hb.height / 2;

    // Lock via the header button → resize handle disappears.
    await page.getByRole('button', { name: 'Lock card' }).first().click();
    await expect(page.getByRole('separator', { name: 'Resize card' })).toHaveCount(0);

    // Dragging the header must NOT move a locked card.
    await page.mouse.move(hx, hy);
    await page.mouse.down();
    await page.mouse.move(hx + 120, hy + 80, { steps: 6 });
    await page.mouse.up();
    const afterLock = await card.boundingBox();
    if (!afterLock) throw new Error('no box');
    expect(Math.abs(afterLock.x - before.x)).toBeLessThan(3);
    expect(Math.abs(afterLock.y - before.y)).toBeLessThan(3);

    // Unlock → resize handle returns.
    await page.getByRole('button', { name: 'Unlock card' }).first().click();
    await expect(page.getByRole('separator', { name: 'Resize card' }).first()).toBeVisible();

    // Maximize → the card grows.
    await page.getByRole('button', { name: 'Maximize card' }).first().click();
    const max = await card.boundingBox();
    if (!max) throw new Error('no box');
    expect(max.width).toBeGreaterThan(before.width);
  } finally {
    await app.close();
  }
});

test('canvas: named canvases switch independently (a canvas = a saved layout)', async () => {
  const { app, page } = await launchApp({ surface: 'canvas' });
  try {
    const cards = page.locator('[data-canvas-card]');
    // Start on the default "Canvas 1" with the home card; add a second card.
    await expect(cards).toHaveCount(1);
    await page.getByRole('button', { name: 'New card' }).click();
    await expect(cards).toHaveCount(2);

    // The switcher chip reflects the open canvas.
    const switcher = page.getByRole('button', { name: 'Switch canvas' });
    await expect(switcher).toContainText('Canvas 1');

    // Create a second, named canvas — it opens empty (panels are per-canvas).
    await switcher.click();
    await page.getByRole('menuitem', { name: 'New canvas' }).click();
    const dialog = page.getByRole('dialog', { name: 'New canvas' });
    await expect(dialog).toBeVisible();
    await dialog.getByPlaceholder('Canvas name').fill('Backend');
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(switcher).toContainText('Backend');
    await expect(cards).toHaveCount(0);

    // A card created here belongs to "Backend" only.
    await page.getByRole('button', { name: 'New card' }).click();
    await expect(cards).toHaveCount(1);

    // Switch back to "Canvas 1" → its two cards return; Backend's card is gone.
    await switcher.click();
    await page.getByRole('menuitem', { name: 'Canvas 1' }).click();
    await expect(switcher).toContainText('Canvas 1');
    await expect(cards).toHaveCount(2);

    // Delete "Backend" (from its own view) — the last canvas can't be deleted,
    // so first switch to it, then delete, landing back on Canvas 1.
    await switcher.click();
    await page.getByRole('menuitem', { name: 'Backend' }).click();
    await expect(cards).toHaveCount(1);
    await switcher.click();
    await page.getByRole('menuitem', { name: 'Delete canvas' }).click();
    await expect(switcher).toContainText('Canvas 1');
    await expect(cards).toHaveCount(2);
  } finally {
    await app.close();
  }
});

test('canvas: named canvases + panel positions persist across a full restart', async () => {
  const userDataDir = makeTempUserDataDir();
  let agentBox: { x: number; y: number } | null = null;

  // Launch 1 — build a two-canvas layout with restart-surviving panels (a
  // terminal on "Canvas 1", an AI chat on "Backend"). home tabs aren't
  // persisted by the tab session, so they won't reappear (and shouldn't).
  {
    const { app, page } = await launchApp({ userDataDir, surface: 'canvas' });
    try {
      const canvas = page.locator('[aria-label="Canvas"]');
      const cards = page.locator('[data-canvas-card]');
      const cb = await canvas.boundingBox();
      if (!cb) throw new Error('no canvas box');

      // Canvas 1: add a terminal via the canvas context menu.
      await page.mouse.click(cb.x + cb.width * 0.5, cb.y + cb.height * 0.82, { button: 'right' });
      await page.getByRole('menuitem', { name: 'New terminal' }).click();
      await expect(cards).toHaveCount(2); // home + terminal

      // Create "Backend" and add an AI chat there.
      const switcher = page.getByRole('button', { name: 'Switch canvas' });
      await switcher.click();
      await page.getByRole('menuitem', { name: 'New canvas' }).click();
      const dialog = page.getByRole('dialog', { name: 'New canvas' });
      await dialog.getByPlaceholder('Canvas name').fill('Backend');
      await dialog.getByRole('button', { name: 'Create' }).click();
      await expect(cards).toHaveCount(0);
      await page.mouse.click(cb.x + cb.width * 0.5, cb.y + cb.height * 0.55, { button: 'right' });
      await page.getByRole('menuitem', { name: 'New AI chat' }).click();
      await expect(cards).toHaveCount(1);
      const box = await cards.first().boundingBox();
      if (!box) throw new Error('no agent card box');
      agentBox = { x: box.x, y: box.y };
      await page.waitForTimeout(400); // let the debounced persist flush
    } finally {
      await app.close();
    }
  }

  // Launch 2 — same userData. The tabs are restored with fresh ids; the canvas
  // re-binds each to its saved spot on the right canvas by descriptor.
  {
    const { app, page } = await launchApp({ userDataDir, surface: 'canvas' });
    try {
      const switcher = page.getByRole('button', { name: 'Switch canvas' });
      const cards = page.locator('[data-canvas-card]');

      // "Backend" was open at close → it reopens with the AI chat at its spot.
      await expect(switcher).toContainText('Backend');
      await expect(cards).toHaveCount(1);
      const box = await cards.first().boundingBox();
      if (!box || !agentBox) throw new Error('no restored card box');
      expect(Math.abs(box.x - agentBox.x)).toBeLessThan(10);
      expect(Math.abs(box.y - agentBox.y)).toBeLessThan(10);

      // The other canvas restored its terminal (the non-persisted home is gone).
      await switcher.click();
      await page.getByRole('menuitem', { name: 'Canvas 1' }).click();
      await expect(switcher).toContainText('Canvas 1');
      await expect(cards).toHaveCount(1);
    } finally {
      await app.close();
    }
  }
});

test('canvas: marquee selects multiple cards and they move together', async () => {
  const { app, page } = await launchApp({ surface: 'canvas' });
  try {
    await page.getByRole('button', { name: 'New card' }).click();
    const cards = page.locator('[data-canvas-card]');
    await expect(cards).toHaveCount(2);
    await page.getByRole('button', { name: 'Fit to content' }).click();

    const canvas = page.locator('[aria-label="Canvas"]');
    const cb = await canvas.boundingBox();
    if (!cb) throw new Error('no canvas box');

    // Marquee from the empty top-left corner across the whole canvas → both cards.
    await page.mouse.move(cb.x + 4, cb.y + 4);
    await page.mouse.down();
    await page.mouse.move(cb.x + cb.width - 4, cb.y + cb.height - 4, { steps: 12 });
    await page.mouse.up();

    // Both cards show the selection ring.
    await expect(cards.nth(0)).toHaveClass(/ring-accent/);
    await expect(cards.nth(1)).toHaveClass(/ring-accent/);

    // Dragging one selected card's header moves the whole selection together.
    const before0 = await cards.nth(0).boundingBox();
    const before1 = await cards.nth(1).boundingBox();
    const header0 = page.locator('[data-card-header]').nth(0);
    const hb = await header0.boundingBox();
    if (!before0 || !before1 || !hb) throw new Error('missing boxes');
    await page.mouse.move(hb.x + hb.width * 0.4, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + hb.width * 0.4 + 80, hb.y + hb.height / 2 + 60, { steps: 10 });
    await page.mouse.up();
    const after0 = await cards.nth(0).boundingBox();
    const after1 = await cards.nth(1).boundingBox();
    if (!after0 || !after1) throw new Error('missing boxes');
    expect(after0.x - before0.x).toBeGreaterThan(30);
    expect(after1.x - before1.x).toBeGreaterThan(30); // the non-dragged card moved too
  } finally {
    await app.close();
  }
});
