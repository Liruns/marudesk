import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const page_url = process.env.PREVIEW_URL ?? 'http://localhost:5291/';
const out = resolve(here, 'diff-spike.png');

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-gpu'],
});
const page = await browser.newPage({
  viewport: { width: 820, height: 420 },
  deviceScaleFactor: 2,
});
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(page_url);
await page
  .waitForSelector('body[data-diff-ready="true"]', { timeout: 20000 })
  .catch(() => console.log('[warn] ready flag not set; screenshotting anyway'));
await page.waitForTimeout(500);
const hasDiff = await page.$('file-diff, [data-diffs], .shiki, pre');
console.log('[info] diff content present:', Boolean(hasDiff));
await page.locator('#app').screenshot({ path: out });
await browser.close();
console.log('wrote', out);
