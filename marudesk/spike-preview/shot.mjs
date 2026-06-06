import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const page_url = process.env.PREVIEW_URL ?? 'http://localhost:5191/';
const out = resolve(here, 'tree-spike.png');

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-gpu'],
});
const page = await browser.newPage({
  viewport: { width: 300, height: 760 },
  deviceScaleFactor: 2,
});
page.on('console', (m) => console.log('[console]', m.type(), m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(page_url);
await page
  .waitForSelector('body[data-tree-ready="true"]', { timeout: 8000 })
  .catch(() => console.log('[warn] ready flag not set; screenshotting anyway'));
// Give the virtualized tree + icon sprite a beat to paint.
await page.waitForTimeout(600);
const host = await page.$('file-tree-container');
console.log('[info] has file-tree-container:', Boolean(host));
await page.locator('aside').screenshot({ path: out });
await browser.close();
console.log('wrote', out);
