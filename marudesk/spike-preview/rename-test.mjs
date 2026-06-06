import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const page_url = process.env.PREVIEW_URL ?? 'http://localhost:5193/';
const shot = resolve(here, 'tree-rename.png');

const TARGET = 'src/lib/cn.ts';
const NEW_NAME = 'classnames.ts';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-gpu'],
});
const page = await browser.newPage({
  viewport: { width: 300, height: 760 },
  deviceScaleFactor: 2,
});
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(page_url);
await page.waitForSelector('body[data-tree-ready="true"]', { timeout: 15000 });

// Trigger inline rename on a known row (the library opens an input in the
// shadow root; Playwright pierces open shadow roots for CSS locators).
const started = await page.evaluate((p) => window.__startRename(p), TARGET);
console.log('[info] startRenaming returned:', started);

const input = page.locator('input').first();
await input.waitFor({ state: 'visible', timeout: 5000 });
await page.locator('aside').screenshot({ path: shot });
console.log('[info] rename input visible; captured', shot);

// Type the new name and commit with Enter.
await input.fill(NEW_NAME);
await input.press('Enter');
await page.waitForTimeout(300);

const events = await page.evaluate(() => window.__renameEvents);
console.log('[result] onRename events:', JSON.stringify(events));

await browser.close();

const ok =
  events.length === 1 &&
  events[0].sourcePath === TARGET &&
  events[0].destinationPath === 'src/lib/' + NEW_NAME;
console.log(ok ? '[PASS] rename pipeline fired with correct paths' : '[FAIL] unexpected rename result');
process.exit(ok ? 0 : 1);
