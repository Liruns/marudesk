import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp } from './helpers/app';
import { openInstrumentFromTask, runCommand, seedGraph } from './helpers/mission-control';

/**
 * The Monaco editor survives the Mission Control redesign as a full-area
 * instrument: a fresh untitled buffer is summoned from the ⌘K command palette
 * ("New Editor"), and a file resource is summoned from a task's Resource chip in
 * the Instrument Dock. The (removed) Home launcher "Code editor" card / tab strip
 * are gone, so these reach the same EditorView surface through the new entry
 * points. "← Graph" returns home.
 */

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

test('editor: new untitled file opens dirty in Monaco', async () => {
  const { app, page } = await launchApp();
  try {
    // "New Editor" summons an untitled Monaco buffer as the full-area instrument.
    await runCommand(page, 'New Editor');
    // The instrument's editor header reads the untitled name (Untitled-1) and the
    // buffer is dirty from creation (no saved baseline → "Unsaved").
    await expect(page.getByRole('button', { name: 'Graph', exact: true })).toBeVisible();
    // Target the editor's OWN dirty filename header by its unique title — the
    // Workbench tab-strip chip also shows "Untitled-1" (the tab identity), so a
    // bare getByText would now match both elements.
    await expect(page.getByTitle('Unsaved file - Ctrl+S to save')).toHaveText('Untitled-1');
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
    // Seed a task whose only output is the image, exposed as a Resource chip.
    await seedGraph(page, {
      tasks: [
        {
          id: 't1',
          title: 'Render a pixel',
          outputs: [{ id: 'r1', kind: 'code', uri: `file:///${rel}`, label: 'image' }],
        },
      ],
    });
    // Make `root` the active workspace so the editor read resolves `pixel.png`
    // against it (the Resource opener strips file:/// to the relative path).
    const summary = await page.evaluate(
      (r) => window.marudesk.invoke('workspace:list', r),
      root,
    );
    if (!summary) throw new Error('workspace did not open');

    // Summoning the image Resource opens it as an editor instrument that renders
    // the image preview (not Monaco). The preview's alt is the bound file path.
    await openInstrumentFromTask(page, 't1', 'image');

    const preview = page.getByRole('img', { name: rel });
    await expect(preview).toBeVisible();
    await expect(preview).toHaveAttribute('src', /^data:image\/png;base64,/);
    await expect(page.locator('.monaco-editor')).toHaveCount(0);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
