import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launchApp } from './helpers/app';
import { runCommand } from './helpers/mission-control';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '..', '.screens');

/**
 * Relative luminance (0 dark → 1 light) of a computed background color. Handles
 * both legacy `rgb(0-255)` / `rgba(...)` AND the modern `color(srgb 0-1 / a)`
 * form Chromium emits for a translucent `color-mix()` — the frosted-glass rail's
 * background-color is a color-mix with alpha, which serializes as srgb floats.
 * Alpha is ignored; we only judge the surface hue's lightness.
 */
function luminance(rgb: string): number {
  const m = rgb.match(/[\d.]+/g);
  if (!m || m.length < 3) return 0;
  let [r, g, b] = m.map(Number);
  // 0-255 (rgb) → normalize to 0-1; color(srgb …) is already 0-1.
  if (r > 1 || g > 1 || b > 1) {
    r /= 255;
    g /= 255;
    b /= 255;
  }
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

test.setTimeout(60_000);

/**
 * Cross-theme guard: flipping to Light must actually re-token the chrome (not just
 * set data-theme). Verifies the instrument rail — a token-driven surface added in
 * this branch — turns light, so a future hard-coded color there is caught.
 */
test('light theme re-tokens the instrument rail', async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const { app, page } = await launchApp();
  try {
    const rail = page.getByRole('navigation', { name: /Instruments|도구/ });
    const darkBg = await rail.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(luminance(darkBg)).toBeLessThan(0.3); // surface-1 is dark by default

    await runCommand(page, 'Open Settings');
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    await page.getByRole('radio', { name: 'Light', exact: true }).click();
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');

    await page.getByRole('button', { name: 'Graph', exact: true }).click();
    await page.waitForTimeout(200);
    const lightBg = await rail.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(luminance(lightBg)).toBeGreaterThan(0.5); // surface-1 flipped to a light value
    await page.screenshot({ path: path.join(OUT, 'light-home.png') });
  } finally {
    await app.close();
  }
});
