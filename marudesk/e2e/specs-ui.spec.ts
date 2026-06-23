import { test, expect } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launchApp } from './helpers/app';
import { runCommand } from './helpers/mission-control';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '..', '.screens');

test.setTimeout(90_000);

test('specs: create a spec with tasks through the Settings panel', async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'maru-specs-'));
  const l = await launchApp();
  const { page } = l;
  try {
    // Specs are per-workspace, so open a folder first.
    const wid = await page.evaluate(
      (root) =>
        window.marudesk
          .invoke('workspaces:create', { name: 'Proj', roots: [{ name: 'Proj', path: root }] })
          .then((w: { id: string }) => w.id),
      repo,
    );
    await page.evaluate((id) => window.marudesk.invoke('workspaces:set-active', { workspaceId: id }), wid);

    await runCommand(page, 'Open Settings');
    await page.getByRole('button', { name: 'Specs', exact: true }).click();
    await page.waitForTimeout(300);

    await page.getByPlaceholder('Spec title').fill('Login page');
    await page.getByPlaceholder('Notes or description (markdown)…').fill('Email + password sign-in.');
    await page.getByRole('button', { name: 'Active', exact: true }).click();
    await page.getByRole('button', { name: 'Add task' }).click();
    await page.getByPlaceholder('Task').fill('Build the form');
    await page.getByRole('button', { name: 'Add task' }).click();
    await page.getByPlaceholder('Task').nth(1).fill('Wire the auth endpoint');
    await page.screenshot({ path: path.join(OUT, 'specs-form.png') });

    await page.getByRole('button', { name: 'Add spec' }).click();
    await page.waitForTimeout(400);

    // The new spec appears as a row with its title + status badge.
    await expect(page.getByText('Login page')).toBeVisible();
    await expect(page.getByText('2 tasks')).toBeVisible();
    await page.screenshot({ path: path.join(OUT, 'specs-list.png') });

    // It persisted to the workspace store (the IPC the panel called).
    const specs = await page.evaluate(() => window.marudesk.invoke('specs:list'));
    expect(Array.isArray(specs) && specs.some((s: { title: string }) => s.title === 'Login page')).toBe(true);
  } finally {
    await l.app.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
