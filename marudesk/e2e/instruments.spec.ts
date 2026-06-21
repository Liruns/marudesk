import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/app';
import { runCommand } from './helpers/mission-control';

/**
 * The ⌘K command palette re-homes the surfaces the redesign deleted from the rails
 * (Explorer / Search / Source Control). Each opens as a full-area instrument; this
 * verifies they are reachable and mount without crashing (the InstrumentStage
 * header confirms the kind; the panel's complementary region confirms it rendered).
 * openInstrument closes the previous instrument, so the commands chain directly.
 */
test('command palette opens the Files, Search, and Source Control instruments', async () => {
  const { app, page } = await launchApp();
  try {
    await runCommand(page, 'Open Files');
    await expect(page.getByText('Instrument · files')).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Explorer' })).toBeVisible();

    await runCommand(page, 'Search in Files');
    await expect(page.getByText('Instrument · search')).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Search' })).toBeVisible();
    await expect(page.getByPlaceholder('Search in files')).toBeVisible();

    await runCommand(page, 'Source Control');
    await expect(page.getByText('Instrument · sourceControl')).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Source Control' })).toBeVisible();

    // "← Graph" returns to the Task graph home.
    await page.getByRole('button', { name: 'Graph' }).click();
    await expect(page.locator('[data-stage="workgraph"]')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Files instrument reflects the active workspace and opening a file hosts the editor', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'marudesk-files-'));
  await fs.writeFile(path.join(base, 'mc-readme.txt'), 'hello from mission control\n', 'utf8');
  const { app, page } = await launchApp();
  try {
    await page.evaluate(async (root) => {
      const rec = await window.marudesk.invoke('workspaces:create', {
        name: 'FilesWS',
        roots: [{ name: 'Root', path: root }],
      });
      await window.marudesk.invoke('workspaces:set-active', { workspaceId: rec.id });
    }, base);

    // Files reflects the ACTIVE workspace (not the "no workspace" empty state) —
    // guards the deck→summary sync that WorkspaceStage's deletion had orphaned.
    await runCommand(page, 'Open Files');
    const explorer = page.getByRole('complementary', { name: 'Explorer' });
    await expect(explorer.getByText('FilesWS')).toBeVisible();

    // Opening a file hosts the editor instrument (no invisible orphan tab) —
    // guards openFileInstrument acting on the authoritative tab id + the QuickOpen
    // routing. QuickOpen is used so the assertion doesn't depend on tree expansion.
    await page.keyboard.press('Control+KeyP');
    const input = page.getByPlaceholder(/Go to file/);
    await expect(input).toBeVisible();
    await input.fill('mc-readme');
    await page.getByRole('button', { name: /mc-readme\.txt/ }).click();
    await expect(page.getByText('Instrument · editor')).toBeVisible();
  } finally {
    await app.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});
