import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { launchApp } from './helpers/app';

/**
 * Workspace management, re-homed to the title-bar WorkspaceSwitcher after the
 * redesign removed the Workspace rail. The switcher lists workspaces and exposes
 * rename / delete through the surviving workspaces:* IPC. (Create pops a native
 * folder picker, so these seed workspaces over IPC with explicit roots, then
 * drive the switcher UI.)
 */

async function createWorkspace(page: Page, name: string, root: string): Promise<string> {
  return page.evaluate(
    async ({ name, root }) => {
      const rec = await window.marudesk.invoke('workspaces:create', {
        name,
        roots: [{ name: 'Root', path: root }],
      });
      return rec.id as string;
    },
    { name, root },
  );
}

test('workspace switcher renames the active workspace', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'marudesk-ws-rename-'));
  const { app, page } = await launchApp();
  try {
    const id = await createWorkspace(page, 'Alpha', base);
    await page.evaluate(
      (wid) => window.marudesk.invoke('workspaces:set-active', { workspaceId: wid }),
      id,
    );

    const trigger = page.getByRole('button', { name: 'Workspace: Alpha' });
    await expect(trigger).toBeVisible();
    await trigger.click();
    await page.getByRole('menuitem', { name: /Rename workspace/ }).click();

    const dialog = page.getByRole('dialog', { name: 'Rename workspace' });
    await dialog.getByRole('textbox').fill('Renamed');
    await page.getByRole('button', { name: 'Rename' }).click();

    await expect(page.getByRole('button', { name: 'Workspace: Renamed' })).toBeVisible();
  } finally {
    await app.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('workspace switcher deletes a non-active workspace', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'marudesk-ws-delete-'));
  const rootA = path.join(base, 'a');
  const rootB = path.join(base, 'b');
  await fs.mkdir(rootA, { recursive: true });
  await fs.mkdir(rootB, { recursive: true });
  const { app, page } = await launchApp();
  try {
    const idKeep = await createWorkspace(page, 'Keep', rootA);
    await createWorkspace(page, 'Drop', rootB);
    // Make Keep active so Drop is the deletable (non-active) one.
    await page.evaluate(
      (wid) => window.marudesk.invoke('workspaces:set-active', { workspaceId: wid }),
      idKeep,
    );
    const trigger = page.getByRole('button', { name: 'Workspace: Keep' });
    await expect(trigger).toBeVisible();
    await trigger.click();
    await page.getByRole('menuitem', { name: 'Delete "Drop"' }).click();

    // The delete path now opens an in-app tokenized confirm (replacing the old
    // native window.confirm) — drive it through to the destructive action.
    const confirm = page.getByRole('dialog', { name: 'Delete workspace "Drop"?' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Delete' }).click();

    // The UI action drove the workspaces:delete IPC — Drop is gone from the registry.
    await expect
      .poll(async () => {
        const snap = await page.evaluate(() => window.marudesk.invoke('workspaces:list'));
        return snap.workspaces.map((w) => w.name);
      })
      .not.toContain('Drop');
  } finally {
    await app.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});
