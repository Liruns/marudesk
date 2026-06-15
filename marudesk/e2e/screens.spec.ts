import { test } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { launchApp, type LaunchedApp } from './helpers/app';

/**
 * Not a real test — a screenshot harness. Launches the built app and captures
 * each surface the UX pass touches (provider picker, Settings → AI Providers,
 * the activity bar / home shell) so we can eyeball the
 * before/after. Renderer-only: the embedded WebContentsView isn't in this page's
 * DOM, but every surface here is React chrome, which is exactly what we're judging.
 *
 * Run: npx playwright test screens   (after npm run build)
 * Output: marudesk/.screens/*.png
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '..', '.screens');

test.setTimeout(45_000);

function makeWorkspaceShotProjects(): {
  readonly base: string;
  readonly alphaFe: string;
  readonly alphaBe: string;
  readonly betaFe: string;
  readonly betaBe: string;
} {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'marudesk-screens-workspace-'));
  const make = (name: string): string => {
    const dir = path.join(base, name);
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'App.tsx'), `export const name = "${name}";\n`);
    fs.writeFileSync(path.join(dir, 'src', 'server.ts'), `export const server = "${name}";\n`);
    return dir;
  };
  return {
    base,
    alphaFe: make('alpha-fe'),
    alphaBe: make('alpha-be'),
    betaFe: make('beta-fe'),
    betaBe: make('beta-be'),
  };
}

async function shot(page: LaunchedApp['page'], name: string): Promise<void> {
  try {
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    console.log(`[screens] ${name}.png`);
  } catch (err) {
    console.log(`[screens] FAILED ${name}: ${(err as Error).message}`);
  }
}

async function windowShot(app: LaunchedApp['app'], name: string): Promise<void> {
  try {
    const pngBase64 = await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error('main window not found');
      const image = await win.capturePage();
      return image.toPNG().toString('base64');
    });
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(pngBase64, 'base64'));
    console.log(`[screens] ${name}.png`);
  } catch (err) {
    console.log(`[screens] FAILED ${name}: ${(err as Error).message}`);
  }
}

async function startWorkspaceShotServer(): Promise<{
  readonly server: Server;
  readonly baseUrl: string;
}> {
  const server = createServer((req, res) => {
    const alpha = req.url?.includes('alpha') ?? false;
    const title = alpha ? 'Alpha preview' : 'Beta preview';
    const accent = alpha ? '#4CB782' : '#5E6AD2';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html>
<html>
  <head>
    <title>${title}</title>
    <style>
      html, body { margin: 0; height: 100%; background: #101114; color: #f7f8f8; font-family: system-ui, sans-serif; }
      main { height: 100%; display: grid; place-items: center; border-top: 6px solid ${accent}; }
      h1 { font-size: 42px; font-weight: 650; letter-spacing: 0; }
      p { color: #8a8f98; font-size: 15px; }
    </style>
  </head>
  <body><main><div><h1>${title}</h1><p>workspace web pane</p></div></main></body>
</html>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('failed to bind workspace shot server');
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

test('capture UX surfaces', async () => {
  fs.mkdirSync(OUT, { recursive: true });
  let launched: LaunchedApp | null = null;
  try {
    launched = await launchApp();
    const { page } = launched;
    await page.waitForTimeout(1200); // let the home view + chrome settle

    const openTab = async (kind: string) => {
      await page.evaluate(
        (k) => window.marudesk.invoke('browser:tabs-new', { kind: k }),
        kind,
      );
      await page.waitForTimeout(700);
    };

    // 1. Default shell — home view + title bar tabs + activity bar.
    await shot(page, '01-home-shell');

    // 2. AI Chat — the provider/model bar (the "list box" the user dislikes).
    await openTab('agent');
    await shot(page, '02-aichat');

    // 2b. Open the model palette (provider glyphs in a list).
    try {
      await page.locator('button[aria-expanded]').first().click({ timeout: 3000 });
      await page.waitForTimeout(500);
      await shot(page, '03-model-palette');
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
    await shot(page, '04-settings-providers');

    // 5. Appearance (interface zoom control, fonts).
    try {
      await page.getByRole('button', { name: 'Appearance' }).click({ timeout: 3000 });
      await page.waitForTimeout(400);
      await shot(page, '07-settings-appearance');
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
        await shot(page, '08-split-view');
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
        await shot(page, '09-split-chip-click');
      }
    } catch (err) {
      console.log(`[screens] split-click skip: ${(err as Error).message}`);
    }

    // 7b. "+" while a split is active must open a New Tab (home view), never the
    // Split-view drop overlay (regression: a stranded strip-drag flag re-armed
    // the seed-split layer over the fresh single view).
    try {
      await page.getByRole('button', { name: 'New tab' }).click();
      await page.waitForTimeout(500);
      await shot(page, '13-plus-after-split');
    } catch (err) {
      console.log(`[screens] plus-after-split skip: ${(err as Error).message}`);
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
      await shot(page, '10-appearance');
      await page.getByRole('button', { name: 'Teal' }).click({ timeout: 3000 });
      await page.waitForTimeout(400);
      await shot(page, '11-accent-teal');
      await page.getByRole('button', { name: 'Violet' }).click({ timeout: 2000 });
      // Color mode (wired to the existing settings theme): flip to Light to
      // confirm the whole chrome re-themes via the popover.
      await page.getByRole('button', { name: 'Light' }).click({ timeout: 2000 });
      await page.waitForTimeout(400);
      await shot(page, '12-light-mode');
    } catch (err) {
      console.log(`[screens] appearance skip: ${(err as Error).message}`);
    }

  } finally {
    if (launched) await launched.app.close();
  }
});

test('capture workspace deck surfaces', async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const fixture = makeWorkspaceShotProjects();
  const shotServer = await startWorkspaceShotServer();
  let launched: LaunchedApp | null = null;

  try {
    launched = await launchApp();
    const { page } = launched;
    await page.waitForTimeout(900);

    try {
      await page.evaluate(
        async ({ alphaFe, alphaBe, betaFe, betaBe, baseUrl }) => {
          const alpha = await window.marudesk.invoke('workspaces:create', {
            name: 'Project Alpha',
            roots: [
              { name: 'FE', path: alphaFe },
              { name: 'BE', path: alphaBe },
            ],
          });
          const beta = await window.marudesk.invoke('workspaces:create', {
            name: 'Project Beta',
            roots: [
              { name: 'FE', path: betaFe },
              { name: 'BE', path: betaBe },
            ],
          });
          await window.marudesk.invoke('browser:tabs-new', {
            kind: 'web',
            workspaceId: alpha.id,
            url: `${baseUrl}/alpha`,
          });
          await window.marudesk.invoke('browser:tabs-new', {
            kind: 'web',
            workspaceId: beta.id,
            url: `${baseUrl}/beta`,
          });
        },
        { ...fixture, baseUrl: shotServer.baseUrl },
      );
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(700);
      await shot(page, '14-workspace-single');
      await page.getByRole('button', { name: 'Split workspace right' }).click();
      await page.getByRole('button', { name: 'Workspace Project Alpha' }).click();
      await page.waitForTimeout(400);
      await shot(page, '15-workspace-split');
      await page.getByRole('button', { name: 'Peek Explorer' }).last().click();
      await page.waitForTimeout(300);
      await shot(page, '16-peek-explorer');
      await page.getByRole('button', { name: 'Close Peek Explorer' }).click();
      await page.waitForTimeout(200);
      await windowShot(launched.app, '17-workspace-web-split');
    } catch (err) {
      console.log(`[screens] workspace skip: ${(err as Error).message}`);
    }
  } finally {
    fs.rmSync(fixture.base, { recursive: true, force: true });
    await closeServer(shotServer.server);
    if (launched) await launched.app.close();
  }
});
