import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, makeTempUserDataDir } from './helpers/app';

async function resize(app: ElectronApplication, w: number, h: number) {
  await app.evaluate(({ BrowserWindow }, s) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) win.setContentSize(s.w, s.h);
  }, { w, h });
  await new Promise((r) => setTimeout(r, 200));
}
async function dark(page: Page) {
  await page.evaluate(() => { localStorage.setItem('marudesk.theme','dark'); document.documentElement.dataset.theme='dark'; });
}

test('sticky notes: create, edit, switch-canvas + restart persistence', async () => {
  const userDataDir = makeTempUserDataDir();
  const TEXT = 'ship the canvas notes';

  {
    const { app, page } = await launchApp({ userDataDir, surface: 'canvas' });
    try {
      await dark(page);
      await resize(app, 1440, 900);
      const canvas = page.locator('[aria-label="Canvas"]');
      const cb = await canvas.boundingBox();
      if (!cb) throw new Error('no canvas');
      // Add a note via the canvas context menu — right-click clearly empty space
      // (upper-right), away from the centered home card.
      await page.mouse.click(cb.x + cb.width * 0.85, cb.y + cb.height * 0.18, { button: 'right' });
      await page.getByRole('menuitem', { name: 'Add note' }).click();
      const note = page.locator('[data-canvas-note]');
      await expect(note).toHaveCount(1);
      await note.getByRole('textbox', { name: 'Note' }).fill(TEXT);
      await page.waitForTimeout(150);

      // Switch to a new canvas, then back — the note must survive the round trip.
      const switcher = page.getByRole('button', { name: 'Switch canvas' });
      await switcher.click();
      await page.getByRole('menuitem', { name: 'New canvas' }).click();
      const dlg = page.getByRole('dialog', { name: 'New canvas' });
      await dlg.getByPlaceholder('Canvas name').fill('Other');
      await dlg.getByRole('button', { name: 'Create' }).click();
      await expect(note).toHaveCount(0); // new canvas has no notes
      await switcher.click();
      await page.getByRole('menuitem', { name: 'Canvas 1' }).click();
      await expect(note).toHaveCount(1);
      await expect(note.getByRole('textbox', { name: 'Note' })).toHaveValue(TEXT);
      await page.waitForTimeout(400); // let the debounced persist flush
    } finally {
      await app.close();
    }
  }

  // Relaunch with the same userData — the note persists across a full restart.
  {
    const { app, page } = await launchApp({ userDataDir, surface: 'canvas' });
    try {
      await resize(app, 1440, 900);
      const note = page.locator('[data-canvas-note]');
      await expect(note).toHaveCount(1);
      await expect(note.getByRole('textbox', { name: 'Note' })).toHaveValue(TEXT);
    } finally {
      await app.close();
    }
  }
});
