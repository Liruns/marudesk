import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, makeTempUserDataDir } from './helpers/app';

async function resize(app: ElectronApplication, w: number, h: number) {
  await app.evaluate(({ BrowserWindow }, s) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) win.setContentSize(s.w, s.h);
  }, { w, h });
  await new Promise((r) => setTimeout(r, 200));
}
async function panBy(page: Page, dx: number, dy: number) {
  const cb = await page.locator('[aria-label="Canvas"]').boundingBox();
  if (!cb) throw new Error('no canvas');
  // Space+drag pans (a plain left-drag on empty canvas marquee-selects). Start in
  // clearly-empty space (right side), away from the centered home card.
  const x = cb.x + cb.width * 0.92, y = cb.y + cb.height * 0.35;
  await page.keyboard.down('Space');
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 14 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  await page.waitForTimeout(150);
}

test('camera bookmarks: save view, jump back, persist across restart', async () => {
  const userDataDir = makeTempUserDataDir();
  {
    const { app, page } = await launchApp({ userDataDir, surface: 'canvas' });
    try {
      await page.evaluate(() => { localStorage.setItem('marudesk.theme','dark'); document.documentElement.dataset.theme='dark'; });
      await resize(app, 1440, 900);
      const card = page.locator('[data-canvas-card]').first();
      const saved = await card.boundingBox();
      if (!saved) throw new Error('no card');
      // Save the current view.
      await page.getByRole('button', { name: 'Saved views' }).click();
      await page.getByRole('menuitem', { name: 'Save current view' }).click();
      await page.waitForTimeout(200);
      // Pan far away — the card leaves its spot.
      await panBy(page, -1200, -800);
      const moved = await card.boundingBox();
      if (!moved) throw new Error('no moved');
      expect(Math.abs(moved.x - saved.x)).toBeGreaterThan(200);
      // Jump back to the saved view.
      await page.getByRole('button', { name: 'Saved views' }).click();
      await page.getByRole('menuitem', { name: 'View 1' }).click();
      await page.waitForTimeout(600);
      const back = await card.boundingBox();
      if (!back) throw new Error('no back');
      expect(Math.abs(back.x - saved.x)).toBeLessThan(12);
      expect(Math.abs(back.y - saved.y)).toBeLessThan(12);
      await page.waitForTimeout(400); // flush persist
    } finally { await app.close(); }
  }
  // Restart — the saved view persists.
  {
    const { app, page } = await launchApp({ userDataDir, surface: 'canvas' });
    try {
      await resize(app, 1440, 900);
      await page.getByRole('button', { name: 'Saved views' }).click();
      await expect(page.getByRole('menuitem', { name: 'View 1' })).toBeVisible();
    } finally { await app.close(); }
  }
});
