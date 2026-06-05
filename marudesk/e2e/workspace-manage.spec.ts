import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp } from './helpers/app';

function mkProject(root: string, name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'App.tsx'), `export const name = "${name}";\n`);
  return dir;
}

test('workspace deck: rename and delete workspaces from the rail', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'marudesk-ws-manage-'));
  const alphaFe = mkProject(base, 'alpha-fe');
  const betaFe = mkProject(base, 'beta-fe');
  const { app, page } = await launchApp();
  try {
    await page.evaluate(
      async ({ alphaFe, betaFe }) => {
        await window.marudesk.invoke('workspaces:create', {
          name: 'Project Alpha',
          roots: [{ name: 'FE', path: alphaFe }],
        });
        await window.marudesk.invoke('workspaces:create', {
          name: 'Project Beta',
          roots: [{ name: 'FE', path: betaFe }],
        });
      },
      { alphaFe, betaFe },
    );
    await page.reload({ waitUntil: 'domcontentloaded' });

    const rail = page.getByRole('navigation', { name: 'Workspace rail' });
    await expect(rail).toBeVisible();

    // Rename Project Beta -> Project Gamma via the rail context menu + dialog.
    await rail.getByRole('button', { name: 'Workspace Project Beta' }).click({ button: 'right' });
    await page.getByRole('menu').getByRole('menuitem', { name: 'Rename workspace' }).click();
    const renameDialog = page.getByRole('dialog', { name: 'Rename workspace' });
    await renameDialog.getByRole('textbox').fill('Project Gamma');
    await renameDialog.getByRole('button', { name: 'Rename' }).click();
    await expect(rail.getByRole('button', { name: 'Workspace Project Gamma' })).toBeVisible();
    await expect(rail.getByRole('button', { name: 'Workspace Project Beta' })).toHaveCount(0);

    // Delete Project Alpha (auto-accept the confirm() prompt).
    page.on('dialog', (dialog) => void dialog.accept());
    await rail.getByRole('button', { name: 'Workspace Project Alpha' }).click({ button: 'right' });
    await page.getByRole('menu').getByRole('menuitem', { name: 'Delete workspace' }).click();
    await expect(rail.getByRole('button', { name: 'Workspace Project Alpha' })).toHaveCount(0);
    await expect(rail.getByRole('button', { name: 'Workspace Project Gamma' })).toBeVisible();
  } finally {
    await app.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('workspace deck: remove a folder root from Peek Explorer', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'marudesk-ws-root-'));
  const fe = mkProject(base, 'alpha-fe');
  const be = mkProject(base, 'alpha-be');
  const { app, page } = await launchApp();
  try {
    await page.evaluate(
      async ({ fe, be }) => {
        await window.marudesk.invoke('workspaces:create', {
          name: 'Project Alpha',
          roots: [{ name: 'FE', path: fe }, { name: 'BE', path: be }],
        });
      },
      { fe, be },
    );
    await page.reload({ waitUntil: 'domcontentloaded' });

    page.on('dialog', (dialog) => void dialog.accept());
    await page.getByRole('button', { name: 'Peek Explorer' }).first().click();

    // Two roots → both expose a remove control. Drop BE.
    await expect(page.getByRole('button', { name: 'Remove root FE' })).toBeVisible();
    await page.getByRole('button', { name: 'Remove root BE' }).click();

    // One root left → the remove control disappears for the survivor.
    await expect(page.getByRole('button', { name: 'Remove root BE' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Remove root FE' })).toHaveCount(0);

    const snapshot = await page.evaluate(() => window.marudesk.invoke('workspaces:list'));
    const alpha = snapshot.workspaces.find((workspace) => workspace.name === 'Project Alpha');
    expect(alpha?.roots.map((root) => root.name)).toEqual(['FE']);
  } finally {
    await app.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('workspace explorer: remove a folder root from the root context menu', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'marudesk-ws-root-menu-'));
  const fe = mkProject(base, 'alpha-fe');
  const be = mkProject(base, 'alpha-be');
  const { app, page } = await launchApp();
  try {
    await page.evaluate(
      async ({ fe, be }) => {
        await window.marudesk.invoke('workspaces:create', {
          name: 'Project Alpha',
          roots: [{ name: 'FE', path: fe }, { name: 'BE', path: be }],
        });
      },
      { fe, be },
    );
    await page.reload({ waitUntil: 'domcontentloaded' });

    const explorer = page.getByRole('complementary', { name: 'Explorer' });
    await expect(explorer.getByRole('button', { name: 'Use root FE' })).toBeVisible();
    await expect(explorer.getByRole('button', { name: 'Use root BE' })).toBeVisible();

    page.on('dialog', (dialog) => void dialog.accept());
    await explorer.getByRole('button', { name: 'Use root BE' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Remove folder from workspace' }).click();

    await expect(explorer.getByRole('button', { name: 'Use root BE' })).toHaveCount(0);
    await expect(explorer.getByRole('button', { name: 'Use root FE' })).toBeVisible();

    const snapshot = await page.evaluate(() => window.marudesk.invoke('workspaces:list'));
    const alpha = snapshot.workspaces.find((workspace) => workspace.name === 'Project Alpha');
    expect(alpha?.roots.map((root) => root.name)).toEqual(['FE']);
  } finally {
    await app.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
