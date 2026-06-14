import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/app';

/**
 * Regression specs for the reported infinite-canvas bugs:
 *  - right-click "New …" must place the NEW card at the cursor and must NOT move
 *    the previously-focused card;
 *  - duplicating a canvas must recreate panels at their saved positions;
 *  - the minimap must reflect the viewport and recenter on click.
 *
 * These exercise the async-tab-creation race: `browser:tabs-new` resolves before
 * the coalesced `browser:tabs-state` push updates the renderer store, so reading
 * `activeTabId` / `placements[id]` right after the await sees STALE data.
 */

type Box = { x: number; y: number; width: number; height: number };
const centerOf = (b: Box) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

test('canvas: right-click New places the new card at the cursor, leaving others put', async () => {
  const { app, page } = await launchApp({ surface: 'canvas' });
  try {
    const cards = page.locator('[data-canvas-card]');
    await expect(cards).toHaveCount(1);
    const homeBefore = await cards.first().boundingBox();
    if (!homeBefore) throw new Error('no home card box');

    const canvas = page.locator('[aria-label="Canvas"]');
    const cb = await canvas.boundingBox();
    if (!cb) throw new Error('no canvas box');
    // An empty point well below the default home card slot.
    const px = cb.x + cb.width * 0.5;
    const py = cb.y + cb.height * 0.85;

    await page.mouse.click(px, py, { button: 'right' });
    // New editor (no external PTY/network) keeps this position check fast + stable.
    await page.getByRole('menuitem', { name: 'New editor' }).click();
    await expect(cards).toHaveCount(2);

    // Identify the home card (the one still ~where it was) and the new one.
    const b0 = await cards.nth(0).boundingBox();
    const b1 = await cards.nth(1).boundingBox();
    if (!b0 || !b1) throw new Error('missing card boxes');
    const dist = (b: Box) => Math.hypot(b.x - homeBefore.x, b.y - homeBefore.y);
    const [home, fresh] = dist(b0) <= dist(b1) ? [b0, b1] : [b1, b0];

    // BUG: the previously-focused (home) card must not have jumped to the cursor.
    expect(Math.abs(home.x - homeBefore.x), 'home card x moved').toBeLessThan(8);
    expect(Math.abs(home.y - homeBefore.y), 'home card y moved').toBeLessThan(8);

    // BUG: the NEW card should be centered on the right-click point.
    const c = centerOf(fresh);
    expect(Math.abs(c.x - px), 'new card not at cursor x').toBeLessThan(60);
    expect(Math.abs(c.y - py), 'new card not at cursor y').toBeLessThan(60);
  } finally {
    await app.close();
  }
});

test('canvas: duplicate canvas recreates panels at their saved positions', async () => {
  const { app, page } = await launchApp({ surface: 'canvas' });
  try {
    const cards = page.locator('[data-canvas-card]');
    await expect(cards).toHaveCount(1);

    // Drag the single home card to a distinctive spot via its header.
    const header = page.locator('[data-card-header]').first();
    const hb = await header.boundingBox();
    if (!hb) throw new Error('no header box');
    const grabX = hb.x + hb.width * 0.4;
    const grabY = hb.y + hb.height / 2;
    await page.mouse.move(grabX, grabY);
    await page.mouse.down();
    await page.mouse.move(grabX + 220, grabY + 160, { steps: 12 });
    await page.mouse.up();

    const movedBox = await cards.first().boundingBox();
    if (!movedBox) throw new Error('no moved card box');

    // Duplicate the canvas.
    const switcher = page.getByRole('button', { name: 'Switch canvas' });
    await switcher.click();
    await page.getByRole('menuitem', { name: 'Duplicate canvas' }).click();
    await expect(switcher).toContainText('copy');
    await expect(cards).toHaveCount(1);

    // The copy's card must land at (approximately) the same screen position.
    const copyBox = await cards.first().boundingBox();
    if (!copyBox) throw new Error('no copy card box');
    expect(Math.abs(copyBox.x - movedBox.x), 'copied card x differs').toBeLessThan(12);
    expect(Math.abs(copyBox.y - movedBox.y), 'copied card y differs').toBeLessThan(12);
  } finally {
    await app.close();
  }
});

test('canvas: a card created while zoomed out still lands at the cursor', async () => {
  const { app, page } = await launchApp({ surface: 'canvas' });
  try {
    const cards = page.locator('[data-canvas-card]');
    await expect(cards).toHaveCount(1);

    // Zoom out a few notches (zoom is centered, so a corner becomes empty).
    // Exact title match targets the canvas control, not the web page-zoom one.
    const zoomOut = page.locator('button[title="Zoom out"]');
    for (let i = 0; i < 3; i += 1) await zoomOut.click();

    const canvas = page.locator('[aria-label="Canvas"]');
    const cb = await canvas.boundingBox();
    if (!cb) throw new Error('no canvas box');
    // A corner well away from the centered home card.
    const px = cb.x + cb.width * 0.82;
    const py = cb.y + cb.height * 0.22;

    await page.mouse.dblclick(px, py);
    await expect(cards).toHaveCount(2);

    // The card whose center is farthest from the container center is the new one.
    const cc = { x: cb.x + cb.width / 2, y: cb.y + cb.height / 2 };
    const b0 = await cards.nth(0).boundingBox();
    const b1 = await cards.nth(1).boundingBox();
    if (!b0 || !b1) throw new Error('missing boxes');
    const fromCenter = (b: Box) => Math.hypot(centerOf(b).x - cc.x, centerOf(b).y - cc.y);
    const fresh = fromCenter(b0) >= fromCenter(b1) ? b0 : b1;
    const c = centerOf(fresh);
    expect(Math.abs(c.x - px), 'zoomed new card not at cursor x').toBeLessThan(70);
    expect(Math.abs(c.y - py), 'zoomed new card not at cursor y').toBeLessThan(70);
  } finally {
    await app.close();
  }
});

test('canvas: dragging the minimap pans the canvas', async () => {
  const { app, page } = await launchApp({ surface: 'canvas' });
  try {
    const cards = page.locator('[data-canvas-card]');
    await expect(cards).toHaveCount(1);
    const before = await cards.first().boundingBox();
    const minimap = page.locator('[aria-label="Canvas minimap"] svg');
    const mb = await minimap.boundingBox();
    if (!before || !mb) throw new Error('missing boxes');

    // Press near the minimap center and drag — the canvas should pan, so the
    // on-screen card shifts.
    await page.mouse.move(mb.x + mb.width / 2, mb.y + mb.height / 2);
    await page.mouse.down();
    await page.mouse.move(mb.x + mb.width / 2 + 30, mb.y + mb.height / 2 + 20, { steps: 8 });
    await page.mouse.up();

    const after = await cards.first().boundingBox();
    if (!after) throw new Error('no card box after pan');
    const moved = Math.abs(after.x - before.x) + Math.abs(after.y - before.y);
    expect(moved, 'minimap drag did not pan the canvas').toBeGreaterThan(8);
  } finally {
    await app.close();
  }
});

test('canvas: duplicate preserves positions of multiple distinct cards', async () => {
  const { app, page } = await launchApp({ surface: 'canvas' });
  try {
    const cards = page.locator('[data-canvas-card]');
    await expect(cards).toHaveCount(1);

    // Second card via context menu, dragged to its own distinct spot.
    const canvas = page.locator('[aria-label="Canvas"]');
    const cb = await canvas.boundingBox();
    if (!cb) throw new Error('no canvas box');
    await page.mouse.click(cb.x + cb.width * 0.5, cb.y + cb.height * 0.85, { button: 'right' });
    // Editor (no PTY) keeps this position check fast + stable across the duplicate.
    await page.getByRole('menuitem', { name: 'New editor' }).click();
    await expect(cards).toHaveCount(2);

    // Drag each card's header to a known spot so the two are clearly separated.
    const dragHeaderBy = async (idx: number, dx: number, dy: number) => {
      const hb = await page.locator('[data-card-header]').nth(idx).boundingBox();
      if (!hb) throw new Error('no header');
      await page.mouse.move(hb.x + hb.width * 0.4, hb.y + hb.height / 2);
      await page.mouse.down();
      await page.mouse.move(hb.x + hb.width * 0.4 + dx, hb.y + hb.height / 2 + dy, { steps: 8 });
      await page.mouse.up();
    };
    await dragHeaderBy(0, 60, 40);
    await dragHeaderBy(1, -40, -30);

    const src = await Promise.all([cards.nth(0).boundingBox(), cards.nth(1).boundingBox()]);
    const srcCenters = src.map((b) => (b ? centerOf(b) : null));
    if (srcCenters.some((c) => !c)) throw new Error('missing source boxes');

    // Duplicate.
    const switcher = page.getByRole('button', { name: 'Switch canvas' });
    await switcher.click();
    await page.getByRole('menuitem', { name: 'Duplicate canvas' }).click();
    await expect(switcher).toContainText('copy');
    await expect(cards).toHaveCount(2);

    const copy = await Promise.all([cards.nth(0).boundingBox(), cards.nth(1).boundingBox()]);
    const copyCenters = copy.map((b) => (b ? centerOf(b) : null));

    // Every source center must be matched by a copy center (order-independent).
    for (const sc of srcCenters) {
      const matched = copyCenters.some(
        (cc) => cc && Math.hypot(cc.x - sc!.x, cc.y - sc!.y) < 14,
      );
      expect(matched, `no copied card near (${sc!.x},${sc!.y})`).toBe(true);
    }
  } finally {
    await app.close();
  }
});

test('canvas: duplicate keeps the source view (pan + zoom), not a reset', async () => {
  const { app, page } = await launchApp({ surface: 'canvas' });
  try {
    const cards = page.locator('[data-canvas-card]');
    await expect(cards).toHaveCount(1);

    // Zoom out so the source view is clearly not the 100%/origin default.
    const zoomOut = page.locator('button[title="Zoom out"]');
    for (let i = 0; i < 2; i += 1) await zoomOut.click();

    const srcBox = await cards.first().boundingBox();
    if (!srcBox) throw new Error('no source card box');

    const switcher = page.getByRole('button', { name: 'Switch canvas' });
    await switcher.click();
    await page.getByRole('menuitem', { name: 'Duplicate canvas' }).click();
    await expect(switcher).toContainText('copy');
    await expect(cards).toHaveCount(1);

    // Same screen rect AND size ⇒ the copy adopted the source's pan + zoom.
    const copyBox = await cards.first().boundingBox();
    if (!copyBox) throw new Error('no copy card box');
    expect(Math.abs(copyBox.x - srcBox.x), 'copy view x differs').toBeLessThan(12);
    expect(Math.abs(copyBox.y - srcBox.y), 'copy view y differs').toBeLessThan(12);
    expect(Math.abs(copyBox.width - srcBox.width), 'copy zoom differs').toBeLessThan(12);
  } finally {
    await app.close();
  }
});

test('canvas: converting a home card via its launcher keeps its position', async () => {
  const { app, page } = await launchApp({ surface: 'canvas' });
  try {
    const cards = page.locator('[data-canvas-card]');
    await expect(cards).toHaveCount(1);

    // Move the home card to a distinctive spot.
    const header = page.locator('[data-card-header]').first();
    const hb = await header.boundingBox();
    if (!hb) throw new Error('no header box');
    await page.mouse.move(hb.x + hb.width * 0.4, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + hb.width * 0.4 + 200, hb.y + hb.height / 2 + 150, { steps: 12 });
    await page.mouse.up();
    const before = await cards.first().boundingBox();
    if (!before) throw new Error('no moved box');

    // Click the in-card "Code editor" launcher → converts the home tab in place.
    await page.getByRole('button', { name: /Code editor/ }).click();
    // Still one card (converted in place), now an editor surface.
    await expect(cards).toHaveCount(1);
    await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 8000 });

    // The converted card must stay where the home card was, not jump to a grid slot.
    const after = await cards.first().boundingBox();
    if (!after) throw new Error('no converted box');
    expect(Math.abs(after.x - before.x), 'converted card x jumped').toBeLessThan(12);
    expect(Math.abs(after.y - before.y), 'converted card y jumped').toBeLessThan(12);
  } finally {
    await app.close();
  }
});

test('canvas: a connection can be made to a merged (group) card', async () => {
  const { app, page } = await launchApp({ surface: 'canvas' });
  try {
    // Two cards → merge into a group (drag header onto header).
    await page.getByRole('button', { name: 'New card' }).click();
    const cards = page.locator('[data-canvas-card]');
    await expect(cards).toHaveCount(2);
    await page.getByRole('button', { name: 'Fit to content' }).click();
    const headers = page.locator('[data-card-header]');
    const h1 = await headers.nth(0).boundingBox();
    const h2 = await headers.nth(1).boundingBox();
    if (!h1 || !h2) throw new Error('no header boxes');
    await page.mouse.move(h1.x + h1.width / 2, h1.y + h1.height / 2);
    await page.mouse.down();
    await page.mouse.move(h2.x + h2.width / 2, h2.y + h2.height / 2, { steps: 12 });
    await page.mouse.up();
    await expect(cards).toHaveCount(1);
    await expect(page.getByRole('tab')).toHaveCount(2); // the group strip

    // Add a third (plain) card and fit so both are on-screen.
    await page.getByRole('button', { name: 'New card' }).click();
    await expect(cards).toHaveCount(2);
    await page.getByRole('button', { name: 'Fit to content' }).click();

    const groupCard = cards.filter({ has: page.getByRole('tab') });
    const plainCard = cards.filter({ hasNot: page.getByRole('tab') });
    const port = plainCard.getByRole('button', { name: 'Connect from right edge' });
    const pb = await port.boundingBox();
    const gb = await groupCard.boundingBox();
    if (!pb || !gb) throw new Error('missing port/group boxes');

    // Drag a connection from the plain card onto the GROUP card.
    await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2);
    await page.mouse.down();
    await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2, { steps: 12 });
    await page.mouse.up();

    // An edge to the group must exist (was silently dropped before the fix).
    await expect(page.locator('[data-edge-id]')).toHaveCount(1);
  } finally {
    await app.close();
  }
});

test('canvas: dragging a multi-selected card onto an unselected card does NOT merge', async () => {
  const { app, page } = await launchApp({ surface: 'canvas' });
  try {
    // Three cards: home (C) + two new (A, B). Fit so all are on-screen.
    await page.getByRole('button', { name: 'New card' }).click();
    await page.getByRole('button', { name: 'New card' }).click();
    const cards = page.locator('[data-canvas-card]');
    await expect(cards).toHaveCount(3);
    await page.getByRole('button', { name: 'Fit to content' }).click();

    const hdr = (i: number) => page.locator('[data-card-header]').nth(i);
    const h0 = await hdr(0).boundingBox();
    const h1 = await hdr(1).boundingBox();
    const h2 = await hdr(2).boundingBox();
    if (!h0 || !h1 || !h2) throw new Error('missing header boxes');

    // Select cards 0 and 1 (shift-click), leaving card 2 unselected.
    await page.mouse.click(h0.x + h0.width * 0.4, h0.y + h0.height / 2);
    await page.keyboard.down('Shift');
    await page.mouse.click(h1.x + h1.width * 0.4, h1.y + h1.height / 2);
    await page.keyboard.up('Shift');

    // Drag card 0's header onto card 2 (unselected). With the fix this just moves
    // the selection; before the fix card 0 silently merged into card 2.
    await page.mouse.move(h0.x + h0.width * 0.4, h0.y + h0.height / 2);
    await page.mouse.down();
    await page.mouse.move(h2.x + h2.width * 0.4, h2.y + h2.height / 2, { steps: 14 });
    await page.mouse.up();

    await expect(cards).toHaveCount(3); // no card swallowed
    await expect(page.getByRole('tab')).toHaveCount(0); // no group strip formed
  } finally {
    await app.close();
  }
});

test('canvas: with an edge selected, Delete removes the edge only (not a focused card)', async () => {
  const { app, page } = await launchApp({ surface: 'canvas' });
  try {
    await page.getByRole('button', { name: 'New card' }).click();
    const cards = page.locator('[data-canvas-card]');
    await expect(cards).toHaveCount(2);
    await page.getByRole('button', { name: 'Fit to content' }).click();

    // Wire an edge from card 0's right port onto card 1 → auto-selected.
    const port = page.getByRole('button', { name: 'Connect from right edge' }).first();
    const pb = await port.boundingBox();
    const c1 = await cards.nth(1).boundingBox();
    if (!pb || !c1) throw new Error('missing boxes');
    await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2);
    await page.mouse.down();
    await page.mouse.move(c1.x + c1.width / 2, c1.y + c1.height / 2, { steps: 10 });
    await page.mouse.up();
    await expect(page.locator('[data-edge-id]')).toHaveCount(1);

    // Focus a card frame (its header) — the edge stays selected.
    const hb = await page.locator('[data-card-header]').first().boundingBox();
    if (!hb) throw new Error('no header');
    await page.mouse.click(hb.x + hb.width * 0.4, hb.y + hb.height / 2);

    await page.keyboard.press('Delete');
    // One Delete = one action: the edge goes, both cards stay.
    await expect(page.locator('[data-edge-id]')).toHaveCount(0);
    await expect(cards).toHaveCount(2);
  } finally {
    await app.close();
  }
});

test('canvas: moving a maximized card exits the maximized state (no stale restore)', async () => {
  const { app, page } = await launchApp({ surface: 'canvas' });
  try {
    await page.getByRole('button', { name: 'Maximize card' }).first().click();
    // Now maximized → the control flips to Restore.
    await expect(page.getByRole('button', { name: 'Restore card' }).first()).toBeVisible();

    // Move the maximized card by its header (away from the corner controls).
    const hb = await page.locator('[data-card-header]').first().boundingBox();
    if (!hb) throw new Error('no header');
    await page.mouse.move(hb.x + hb.width * 0.3, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + hb.width * 0.3 + 80, hb.y + hb.height / 2 + 60, { steps: 10 });
    await page.mouse.up();

    // Moving un-maximizes, so the control is back to Maximize (no stale preMax).
    await expect(page.getByRole('button', { name: 'Maximize card' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Restore card' })).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('canvas: New card lands in view (no overlap) after the canvas is panned away', async () => {
  const { app, page } = await launchApp({ surface: 'canvas' });
  try {
    const canvas = page.locator('[aria-label="Canvas"]');
    const cb = await canvas.boundingBox();
    if (!cb) throw new Error('no canvas box');
    const cards = page.locator('[data-canvas-card]');
    await expect(cards).toHaveCount(1);

    // Pan far away with the wheel so the home card leaves the viewport.
    await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
    for (let i = 0; i < 8; i += 1) await page.mouse.wheel(0, 600);

    await page.getByRole('button', { name: 'New card' }).click();
    await expect(cards).toHaveCount(2);

    // The new card is fully within the visible canvas.
    const boxes = await cards.evaluateAll((els) => els.map((e) => e.getBoundingClientRect()));
    const inView = boxes.filter(
      (b) =>
        b.x >= cb.x - 2 && b.y >= cb.y - 2 && b.x + b.width <= cb.x + cb.width + 2 && b.y + b.height <= cb.y + cb.height + 2,
    );
    expect(inView.length, 'new card not visible in viewport').toBeGreaterThanOrEqual(1);
  } finally {
    await app.close();
  }
});

test('canvas: arrow keys move a whole multi-selection together', async () => {
  const { app, page } = await launchApp({ surface: 'canvas' });
  try {
    await page.getByRole('button', { name: 'New card' }).click();
    const cards = page.locator('[data-canvas-card]');
    await expect(cards).toHaveCount(2);
    await page.getByRole('button', { name: 'Fit to content' }).click();

    const canvas = page.locator('[aria-label="Canvas"]');
    const cb = await canvas.boundingBox();
    if (!cb) throw new Error('no canvas box');

    // Marquee-select both cards.
    await page.mouse.move(cb.x + 4, cb.y + 4);
    await page.mouse.down();
    await page.mouse.move(cb.x + cb.width - 4, cb.y + cb.height - 4, { steps: 12 });
    await page.mouse.up();
    await expect(cards.nth(0)).toHaveClass(/ring-accent/);
    await expect(cards.nth(1)).toHaveClass(/ring-accent/);

    const before0 = await cards.nth(0).boundingBox();
    const before1 = await cards.nth(1).boundingBox();
    // Click one card's header to focus its frame WITHOUT dropping the selection.
    const hb = await page.locator('[data-card-header]').nth(0).boundingBox();
    if (!before0 || !before1 || !hb) throw new Error('missing boxes');
    await page.mouse.click(hb.x + hb.width * 0.4, hb.y + hb.height / 2);

    // Arrow keys nudge the whole selection.
    for (let i = 0; i < 6; i += 1) await page.keyboard.press('ArrowRight');
    for (let i = 0; i < 6; i += 1) await page.keyboard.press('ArrowDown');

    const after0 = await cards.nth(0).boundingBox();
    const after1 = await cards.nth(1).boundingBox();
    if (!after0 || !after1) throw new Error('missing boxes');
    expect(after0.x - before0.x, 'focused card did not move').toBeGreaterThan(10);
    expect(after1.x - before1.x, 'other selected card did not move').toBeGreaterThan(10);
  } finally {
    await app.close();
  }
});

test('canvas: a forwarded canvas:wheel event zooms the canvas', async () => {
  // The preload→main half (a web card's Ctrl+wheel → 'canvas:web-wheel' → main)
  // is covered by a standalone Electron probe; native wheel can't be driven from
  // Playwright. This covers the renderer half: the host event the canvas listens
  // for must zoom the plane.
  const { app, page } = await launchApp({ surface: 'canvas' });
  try {
    const zoomBtn = page.locator('[aria-label="Canvas"] button[title="Reset zoom to 100%"]');
    const before = (await zoomBtn.textContent()) ?? '';
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html'));
      if (!win) return;
      for (let i = 0; i < 6; i += 1) {
        win.webContents.send('canvas:wheel', { tabId: 'x', deltaY: -150 });
      }
    });
    await expect.poll(async () => (await zoomBtn.textContent()) ?? '').not.toBe(before);
  } finally {
    await app.close();
  }
});

test('canvas: minimap shows a viewport box and recenters on click', async () => {
  const { app, page } = await launchApp({ surface: 'canvas' });
  try {
    const minimap = page.locator('[aria-label="Canvas minimap"] svg');
    await expect(minimap).toBeVisible();
    // The viewport overlay rect (accent stroke) should be present.
    const viewportRect = minimap.locator('rect[stroke="var(--accent)"]');
    await expect(viewportRect).toHaveCount(1);

    const before = await viewportRect.boundingBox();
    const mb = await minimap.boundingBox();
    if (!before || !mb) throw new Error('missing minimap boxes');

    // Click a corner of the minimap → the viewport should move toward it.
    await page.mouse.click(mb.x + mb.width * 0.8, mb.y + mb.height * 0.8);
    await page.waitForTimeout(120);
    const after = await viewportRect.boundingBox();
    if (!after) throw new Error('no viewport rect after click');
    const moved = Math.abs(after.x - before.x) + Math.abs(after.y - before.y);
    expect(moved, 'minimap click did not move the viewport box').toBeGreaterThan(2);
  } finally {
    await app.close();
  }
});
