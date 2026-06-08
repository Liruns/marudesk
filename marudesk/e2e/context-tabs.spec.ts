import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/app';

/**
 * Supervisor rail (§3.5) + Specs panel (§3.10) live as ContextDrawer tabs. Open
 * the drawer, switch to each new tab, and drive the Specs create flow end-to-end
 * (the spec persists via specs:* IPC and renders back).
 */
test('context drawer: supervisor + specs tabs', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'marudesk-ctx-'));
  const { app, page } = await launchApp();
  try {
    await page.evaluate(
      (root) =>
        window.marudesk.invoke('workspaces:create', {
          name: 'Ctx',
          roots: [{ name: 'Root', path: root }],
        }),
      ws,
    );

    // Open the context drawer from the activity bar.
    await page.getByRole('button', { name: 'Show context panel' }).click();

    // Supervisor tab: cross-thread overview + recent actions.
    await page.getByRole('tab', { name: 'Supervisor' }).click();
    await expect(page.getByText('Recent page actions')).toBeVisible();

    // Specs tab: create a spec (default title), then rename it inline.
    await page.getByRole('tab', { name: 'Specs' }).click();
    await expect(page.getByRole('button', { name: 'New spec' })).toBeVisible();
    await page.getByRole('button', { name: 'New spec' }).click();
    const title = page.getByPlaceholder('Spec title');
    await expect(title).toBeVisible();
    await title.fill('Checkout flow');
    await title.blur();
    await expect(page.getByText('Checkout flow')).toBeVisible();

    // It really persisted to .marudesk/specs.
    await expect
      .poll(() => fs.existsSync(path.join(ws, '.marudesk', 'specs')) && fs.readdirSync(path.join(ws, '.marudesk', 'specs')).length)
      .toBeGreaterThan(0);
  } finally {
    await app.close();
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
