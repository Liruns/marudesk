import { test } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launchApp, type LaunchedApp } from './helpers/app';

/**
 * Not a real test — a screenshot harness. Launches the built app and captures
 * each surface the UX pass touches (provider picker, Settings → AI Providers,
 * Settings → Remote, the activity bar / home shell) so we can eyeball the
 * before/after. Renderer-only: the embedded WebContentsView isn't in this page's
 * DOM, but every surface here is React chrome, which is exactly what we're judging.
 *
 * Run: npx playwright test screens   (after npm run build)
 * Output: marudesk/.screens/*.png
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '..', '.screens');

test('capture UX surfaces', async () => {
  fs.mkdirSync(OUT, { recursive: true });
  let launched: LaunchedApp | null = null;
  try {
    launched = await launchApp();
    const { page } = launched;
    await page.waitForTimeout(1200); // let the home view + chrome settle

    const shot = async (name: string) => {
      try {
        await page.screenshot({ path: path.join(OUT, `${name}.png`) });
        console.log(`[screens] ${name}.png`);
      } catch (err) {
        console.log(`[screens] FAILED ${name}: ${(err as Error).message}`);
      }
    };

    const openTab = async (kind: string) => {
      await page.evaluate(
        (k) => window.marudesk.invoke('browser:tabs-new', { kind: k }),
        kind,
      );
      await page.waitForTimeout(700);
    };

    // 1. Default shell — home view + title bar tabs + activity bar.
    await shot('01-home-shell');

    // 2. AI Chat — the provider/model bar (the "list box" the user dislikes).
    await openTab('agent');
    await shot('02-aichat');

    // 2b. Open the model palette (provider glyphs in a list).
    try {
      await page.locator('button[aria-expanded]').first().click({ timeout: 3000 });
      await page.waitForTimeout(500);
      await shot('03-model-palette');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    } catch (err) {
      console.log(`[screens] palette skip: ${(err as Error).message}`);
    }

    // 3. Settings → AI Providers (alphabet-glyph cards).
    await openTab('settings');
    try {
      await page.getByRole('button', { name: 'AI Providers' }).click({ timeout: 3000 });
      await page.waitForTimeout(500);
    } catch (err) {
      console.log(`[screens] providers nav skip: ${(err as Error).message}`);
    }
    await shot('04-settings-providers');

    // 4. Settings → Remote access (port/URL exposure).
    try {
      await page.getByRole('button', { name: 'Remote access' }).click({ timeout: 3000 });
      await page.waitForTimeout(400);
      await shot('05-settings-remote-off');
      // Turn the server on to reveal port + URL + pairing surface.
      await page.getByRole('radio', { name: 'On' }).first().click({ timeout: 3000 });
      await page.waitForTimeout(900);
      await shot('06-settings-remote-on');
    } catch (err) {
      console.log(`[screens] remote skip: ${(err as Error).message}`);
    }

    // 5. Appearance (interface zoom control, fonts).
    try {
      await page.getByRole('button', { name: 'Appearance' }).click({ timeout: 3000 });
      await page.waitForTimeout(400);
      await shot('07-settings-appearance');
    } catch (err) {
      console.log(`[screens] appearance skip: ${(err as Error).message}`);
    }

    // 6. Split view — two distinct tabs tiled, to show the cleaned-up strip
    // group bracket + the grid. Driven with real mouse events so Chromium
    // promotes the chip drag to native DnD (mirrors grid.spec.ts).
    try {
      await page.getByRole('button', { name: 'New tab' }).click();
      await page.getByRole('button', { name: 'New tab' }).click();
      await page.waitForTimeout(400);
      const tabs = page.getByRole('tab');
      const count = await tabs.count();
      // Activate the second-to-last tab, drag the last (distinct) tab onto it.
      await tabs.nth(count - 2).click();
      await page.waitForTimeout(200);
      const main = await page.getByRole('main').boundingBox();
      if (main) {
        await tabs.nth(count - 1).hover();
        await page.mouse.down();
        await page.mouse.move(main.x + main.width * 0.5, main.y + main.height * 0.5, { steps: 14 });
        await page.mouse.move(main.x + main.width * 0.85, main.y + main.height * 0.5, { steps: 14 });
        await page.mouse.up();
        await page.waitForTimeout(500);
        await shot('08-split-view');
      }
    } catch (err) {
      console.log(`[screens] split skip: ${(err as Error).message}`);
    }

    // 7. Click a tab inside the split group. Regression guard: activating a
    // feature chip used to be misread by main as "switched outside the grid",
    // tearing down grid mode and blanking sibling panes. The grid must stay
    // intact — and this also shows the cleaned-up merge bracket.
    try {
      const tabsInStrip = page.getByRole('tab');
      const n = await tabsInStrip.count();
      if (n >= 2) {
        await tabsInStrip.nth(n - 2).click();
        await page.waitForTimeout(400);
        await shot('09-split-chip-click');
      }
    } catch (err) {
      console.log(`[screens] split-click skip: ${(err as Error).message}`);
    }

    // 8. Appearance popover (accent presets) from the activity-bar gear. Apply a
    // non-default accent to confirm the [data-accent] swap reskins the whole UI,
    // then reset to violet so the harness doesn't leave a sticky pref behind.
    try {
      const rail = page.getByRole('navigation', { name: 'Activity bar' });
      await rail.getByRole('button', { name: 'Settings' }).click({ timeout: 3000 });
      await page.waitForTimeout(250);
      await page.getByRole('menuitem', { name: /Appearance/ }).click({ timeout: 3000 });
      await page.waitForTimeout(300);
      await shot('10-appearance');
      await page.getByRole('button', { name: 'Teal' }).click({ timeout: 3000 });
      await page.waitForTimeout(400);
      await shot('11-accent-teal');
      await page.getByRole('button', { name: 'Violet' }).click({ timeout: 2000 });
    } catch (err) {
      console.log(`[screens] appearance skip: ${(err as Error).message}`);
    }
  } finally {
    if (launched) await launched.app.close();
  }
});
