import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const baseUrl = process.env.PREVIEW_URL ?? 'http://localhost:5291/';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-gpu'],
});

async function shoot(style, width, file) {
  const page = await browser.newPage({ viewport: { width, height: 460 }, deviceScaleFactor: 2 });
  const loaded = [];
  page.on('requestfinished', (r) => {
    const u = r.url();
    if (u.includes('/assets/')) loaded.push(u.split('/assets/')[1]);
  });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(`${baseUrl}?style=${style}`);
  await page.waitForSelector('body[data-diff-ready="true"]', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(800);
  const wasm = loaded.filter((u) => /wasm/i.test(u));
  console.log(`[${style}] runtime chunks: ${loaded.length}, wasm loaded: ${wasm.length}`);
  await page.locator('#app').screenshot({ path: resolve(here, file) });
  await page.close();
  console.log('wrote', file);
}

await shoot('unified', 820, 'diff-spike.png');
await shoot('split', 1120, 'diff-split.png');
await browser.close();
