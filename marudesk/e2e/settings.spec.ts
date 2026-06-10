import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp } from './helpers/app';

function mkWorkspaceRoot(base: string, name: string): string {
  const dir = path.join(base, name);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'App.tsx'), `export const name = "${name}";\n`);
  return dir;
}

test('settings: opens as a tab; theme + zoom apply live', async () => {
  const { app, page } = await launchApp();
  try {
    // Gear → context menu → Settings tab.
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

    // Theme flips the documentElement data-theme.
    await page.getByRole('radio', { name: 'Light' }).click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
      .toBe('light');
    await page.getByRole('radio', { name: 'Dark' }).click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
      .toBe('dark');

    // Theme palette flips the documentElement data-palette; Graphite (the
    // default) clears the attribute back to the base tokens.
    await page.getByRole('button', { name: 'Midnight' }).click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.palette))
      .toBe('midnight');
    await page.getByRole('button', { name: 'Graphite' }).click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.palette))
      .toBeUndefined();

    // Interface zoom scales the root font-size (rem anchor).
    await page.getByRole('button', { name: 'Increase Interface zoom' }).click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          parseFloat(document.documentElement.style.fontSize || '16'),
        ),
      )
      .toBeGreaterThan(16);
  } finally {
    await app.close();
  }
});

test('settings: search jumps to an individual setting in another category', async () => {
  const { app, page } = await launchApp();
  try {
    // Given: the Settings tab is open on its default (Appearance) category.
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible();

    // When: the user searches for a control that lives in another category.
    await page.getByPlaceholder('Search settings').fill('shell');

    // Then: the result surfaces and clicking it lands on the owning category.
    const result = page.getByRole('button', { name: 'Default shell' });
    await expect(result).toBeVisible();

    // And: a category-level synonym (not any setting's own label) still finds
    // that category's settings.
    await page.getByPlaceholder('Search settings').fill('database');
    await expect(
      page.getByRole('button', { name: 'Save AI Chat sessions' }),
    ).toBeVisible();

    // Clicking a result jumps to the owning category.
    await page.getByPlaceholder('Search settings').fill('shell');
    await page.getByRole('button', { name: 'Default shell' }).click();
    await expect(page.getByRole('heading', { name: 'Terminal' })).toBeVisible();
    await expect(page.getByText('Default shell', { exact: true })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('settings: Ctrl/Cmd+, opens the Settings tab', async () => {
  const { app, page } = await launchApp();
  try {
    // Given: the app is focused on the default shell (no editor open).
    await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();

    // When: the user presses the open-settings accelerator.
    await page.keyboard.press('Control+Comma');

    // Then: the Settings tab opens.
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('settings: opens in the active workspace instead of reusing another workspace tab', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'marudesk-settings-ws-'));
  const alphaRoot = mkWorkspaceRoot(base, 'alpha');
  const betaRoot = mkWorkspaceRoot(base, 'beta');
  const { app, page } = await launchApp();
  try {
    const records = await page.evaluate(
      async ({ alphaRoot, betaRoot }) => {
        const alpha = await window.marudesk.invoke('workspaces:create', {
          name: 'Project Alpha',
          roots: [{ name: 'Alpha', path: alphaRoot }],
        });
        const beta = await window.marudesk.invoke('workspaces:create', {
          name: 'Project Beta',
          roots: [{ name: 'Beta', path: betaRoot }],
        });
        return { alphaId: alpha.id, betaId: beta.id };
      },
      { alphaRoot, betaRoot },
    );

    await page.reload({ waitUntil: 'domcontentloaded' });

    const rail = page.getByRole('navigation', { name: 'Workspace rail' });
    await expect(rail.getByRole('button', { name: 'Workspace Project Alpha' })).toBeVisible();
    await expect(rail.getByRole('button', { name: 'Workspace Project Beta' })).toBeVisible();

    await rail.getByRole('button', { name: 'Workspace Project Alpha' }).click();
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();

    await expect
      .poll(async () => {
        const snapshot = await page.evaluate(() =>
          window.marudesk.invoke('browser:tabs-snapshot'),
        );
        return snapshot.tabs.find((tab) => tab.id === snapshot.activeTabId)?.workspaceId;
      })
      .toBe(records.alphaId);

    await rail.getByRole('button', { name: 'Workspace Project Beta' }).click();
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();

    const snapshot = await page.evaluate(() =>
      window.marudesk.invoke('browser:tabs-snapshot'),
    );
    const active = snapshot.tabs.find((tab) => tab.id === snapshot.activeTabId);
    const settingsWorkspaces = snapshot.tabs
      .filter((tab) => tab.kind === 'settings')
      .map((tab) => tab.workspaceId)
      .sort();

    expect(active?.kind).toBe('settings');
    expect(active?.workspaceId).toBe(records.betaId);
    expect(settingsWorkspaces).toEqual([records.alphaId, records.betaId].sort());
  } finally {
    await app.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('settings: Plugins open-folder button invokes the install-folder handler', async () => {
  const { app, page } = await launchApp();
  try {
    await app.evaluate(({ ipcMain }) => {
      const g = globalThis as typeof globalThis & { __pluginsOpenFolderCalls?: number };
      g.__pluginsOpenFolderCalls = 0;
      ipcMain.removeHandler('plugins:open-folder');
      ipcMain.handle('plugins:open-folder', () => {
        g.__pluginsOpenFolderCalls = (g.__pluginsOpenFolderCalls ?? 0) + 1;
        return { path: 'C:\\fake\\plugins' };
      });
    });

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Plugins' }).click();
    await expect(page.getByRole('heading', { name: 'Plugins' })).toBeVisible();
    await page.getByRole('button', { name: 'Open plugins folder' }).click();

    await expect.poll(() =>
      app.evaluate(() => {
        const g = globalThis as typeof globalThis & { __pluginsOpenFolderCalls?: number };
        return g.__pluginsOpenFolderCalls ?? 0;
      }),
    ).toBe(1);
  } finally {
    await app.close();
  }
});

test('settings: about exposes GitHub and update controls', async () => {
  const { app, page } = await launchApp();
  try {
    // Given: the Settings tab is open.
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();

    // When: the user opens About.
    await page.getByRole('button', { name: 'About' }).click();

    // Then: source and update affordances are available.
    await expect(page.getByRole('heading', { name: 'About' })).toBeVisible();
    await expect(page.getByText('GitHub', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open GitHub' })).toBeVisible();
    await expect(page.getByText('Updates', { exact: true })).toBeVisible();

    // When: the user checks for updates.
    await page.getByRole('button', { name: 'Check' }).click();

    // Then: the check resolves into one of the user-facing release statuses.
    await expect(
      page.getByRole('main').getByText(
        /available on GitHub Releases|latest GitHub release|Could not reach GitHub Releases|No GitHub release has been published|update response this app could not read/,
      ),
    ).toBeVisible({ timeout: 12_000 });
  } finally {
    await app.close();
  }
});
