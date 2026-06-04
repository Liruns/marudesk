import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp } from './helpers/app';

function mkProject(root: string, name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'App.tsx'), `export const n = "${name}";\n`);
  return dir;
}

// On-screen WebContentsView rects from the main process (hidden views sit at
// the offscreen sentinel x ≈ -10000). The first child is the full-window React
// host; tab web views follow.
async function onScreenWebViews(
  app: import('@playwright/test').ElectronApplication,
): Promise<{ x: number; y: number; width: number; height: number }[]> {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return [];
    return (win.contentView.children ?? [])
      .map((v) => v.getBounds())
      .filter((b) => b.x > -1000 && b.width > 20 && b.height > 20);
  });
}

// Regression: splitting the workspace deck must not collapse a pane's stage to
// zero height. A leaf pane's `WorkspacePane` fills via `flex-1`, so its split
// wrappers must be flex containers — otherwise the web view measures 0px tall
// and selecting a (pre-split) tab shows a blank pane.
test('workspace split: selecting a pre-split tab shows its grid (non-zero height)', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'marudesk-split-regression-'));
  const { app, page } = await launchApp();
  try {
    const alphaId = await page.evaluate(
      async ({ alpha, beta }) => {
        const a = await window.marudesk.invoke('workspaces:create', {
          name: 'Project Alpha',
          roots: [{ name: 'FE', path: alpha }],
        });
        await window.marudesk.invoke('workspaces:create', {
          name: 'Project Beta',
          roots: [{ name: 'FE', path: beta }],
        });
        // Two web tabs in Alpha so we can tile them into a split group.
        await window.marudesk.invoke('browser:tabs-new', { kind: 'web', url: 'about:blank', workspaceId: a.id });
        await window.marudesk.invoke('browser:tabs-new', { kind: 'web', url: 'about:blank', workspaceId: a.id });
        await window.marudesk.invoke('workspaces:set-active', { workspaceId: a.id });
        return a.id;
      },
      { alpha: mkProject(base, 'alpha'), beta: mkProject(base, 'beta') },
    );
    expect(alphaId).toBeTruthy();

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('navigation', { name: 'Workspace rail' })).toBeVisible();

    // Pre-split: tile Alpha's first web tab beside the active one (drag right).
    await expect(page.getByRole('tab')).toHaveCount(2);
    const box = await page.getByRole('main').boundingBox();
    if (!box) throw new Error('no stage box');
    await page.getByRole('tab').nth(0).hover();
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 12 });
    await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.5, { steps: 12 });
    await page.mouse.up();
    await expect(page.getByLabel('Grid pane')).toHaveCount(2);

    // Split the workspace deck, then move Beta into the right pane so the two
    // panes hold different workspaces (Alpha keeps its split group on the left).
    await page.getByRole('button', { name: 'Split workspace right' }).first().click();
    await page.getByRole('button', { name: 'Workspace Project Beta' }).click();

    const alphaPane = page.getByRole('region', { name: 'Project Alpha' });
    await expect(alphaPane).toBeVisible();

    // Leave the split, then re-select a grouped (pre-split) tab in Alpha.
    await alphaPane.getByRole('tab').last().click();
    await alphaPane
      .getByRole('group', { name: 'Split view group' })
      .getByRole('tab')
      .first()
      .click();
    await expect(alphaPane.getByLabel('Grid pane')).toHaveCount(2);

    const aBox = await alphaPane.boundingBox();
    if (!aBox) throw new Error('no alpha pane box');
    await expect
      .poll(async () => {
        const views = await onScreenWebViews(app);
        return views.filter(
          (b) => b.x >= aBox.x - 5 && b.x + b.width <= aBox.x + aBox.width + 5,
        ).length;
      })
      .toBeGreaterThanOrEqual(2);
  } finally {
    await app.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
