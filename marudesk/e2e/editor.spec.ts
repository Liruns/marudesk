import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp } from './helpers/app';

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

test('editor: new untitled file opens dirty in Monaco', async () => {
  const { app, page } = await launchApp();
  try {
    await page.getByRole('button', { name: 'Code editor' }).click();
    // Untitled tab is titled Untitled-1 and reads dirty from creation.
    await expect(page.getByRole('tab', { name: /Untitled-1/ })).toBeVisible();
    await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Unsaved')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('editor: image files open as a preview', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marudesk-image-workspace-'));
  const rel = 'pixel.png';
  fs.writeFileSync(path.join(root, rel), Buffer.from(PNG_1X1, 'base64'));

  const { app, page } = await launchApp();
  try {
    await page.evaluate(
      async ({ root, rel }) => {
        const summary = await window.marudesk.invoke('workspace:list', root);
        if (!summary) throw new Error('workspace did not open');
        await window.marudesk.invoke('browser:tabs-new', {
          kind: 'editor',
          path: rel,
        });
      },
      { root, rel },
    );

    const preview = page.getByRole('img', { name: rel });
    await expect(preview).toBeVisible();
    await expect(preview).toHaveAttribute('src', /^data:image\/png;base64,/);
    await expect(page.locator('.monaco-editor')).toHaveCount(0);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
