import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launchApp } from './helpers/app';
import { runCommand } from './helpers/mission-control';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '..', '.screens');

/** Relative luminance of a `rgb(...)`/`rgba(...)` string (0 dark → 1 light). */
function luminance(rgb: string): number {
  const m = rgb.match(/(\d+(?:\.\d+)?)/g);
  if (!m || m.length < 3) return 0;
  const [r, g, b] = m.map(Number);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
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
