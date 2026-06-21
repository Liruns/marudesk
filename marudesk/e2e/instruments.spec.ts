import { execFileSync } from 'node:child_process';
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
    // The InstrumentStage header label is the source of truth for which kind is
    // hosted; target it by test id so the assertion can't collide with same-text
    // panel content (e.g. the Search panel's own "Search" heading).
    const kindLabel = page.getByTestId('instrument-kind');
    await runCommand(page, 'Open Files');
    await expect(kindLabel).toHaveText('Files');
    await expect(page.getByRole('complementary', { name: 'Explorer' })).toBeVisible();

    await runCommand(page, 'Search in Files');
    await expect(kindLabel).toHaveText('Search');
    await expect(page.getByRole('complementary', { name: 'Search' })).toBeVisible();
    await expect(page.getByPlaceholder('Search in files')).toBeVisible();

    await runCommand(page, 'Source Control');
    await expect(kindLabel).toHaveText('Source Control');
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
    await expect(page.getByTestId('instrument-kind')).toHaveText('Editor');
  } finally {
    await app.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

/**
 * Source Control's create-branch flow is driven entirely in-app (the native
 * window.prompt it used to raise can't be driven by Playwright). Opening the
 * branch switcher → "Create branch…" reveals a tokenized inline prompt; filling
 * it and submitting creates + checks out the branch, which the switcher reflects.
 */
test('Source Control creates a branch via the in-app prompt (no native dialog)', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'marudesk-sc-branch-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['commit', '--allow-empty', '-m', 'init']);

  const { app, page } = await launchApp();
  try {
    await page.evaluate(async (root) => {
      const rec = await window.marudesk.invoke('workspaces:create', {
        name: 'RepoWS',
        roots: [{ name: 'Root', path: root }],
      });
      await window.marudesk.invoke('workspaces:set-active', { workspaceId: rec.id });
    }, repo);

    await runCommand(page, 'Source Control');
    const panel = page.getByRole('complementary', { name: 'Source Control' });
    await expect(panel).toBeVisible();
    const switcher = panel.getByTestId('git-branch-switcher');
    // Current branch is shown before we switch.
    await expect(switcher).toContainText('main');

    // Open the branch switcher and pick "Create branch…".
    await switcher.click();
    await page.getByRole('menuitem', { name: 'Create branch…' }).click();

    // The in-app prompt (not a native dialog) accepts the new name and submits.
    const prompt = page.getByTestId('git-branch-prompt');
    await expect(prompt).toBeVisible();
    await prompt.getByRole('textbox').fill('feature/in-app');
    await prompt.getByRole('button', { name: 'Create' }).click();

    // The switcher now reflects the freshly created + checked-out branch, and the
    // prompt has dismissed itself.
    await expect(switcher).toContainText('feature/in-app');
    await expect(prompt).toBeHidden();
  } finally {
    await app.close();
    await fs.rm(repo, { recursive: true, force: true });
  }
});
