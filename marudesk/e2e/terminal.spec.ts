import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { launchApp, makeTempUserDataDir } from './helpers/app';

// The key node-pty verification: launch a terminal, type a command, and assert
// the output round-trips back through xterm. If node-pty failed to load, the
// session surfaces "[failed to start terminal: …]" and nothing echoes — so the
// echo assertion fails, catching the native-module load problem.
test('terminal: shell starts and echoes input (node-pty round-trip)', async () => {
  const { app, page } = await launchApp();
  try {
    await page.getByRole('button', { name: 'Terminal' }).click();
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 10_000 });

    await page.locator('.xterm-screen').click();
    await page.keyboard.type('echo marudesktest');
    await page.keyboard.press('Enter');

    await expect(page.locator('.xterm')).toContainText('marudesktest', {
      timeout: 10_000,
    });
  } finally {
    await app.close();
  }
});

// Regression for the "File not found:" bug: a persisted shell that isn't a real
// executable (the reported stale value was "system"; here a bogus path) used to
// be handed straight to node-pty, which failed and nothing echoed. The resolver
// must now fall back to a working shell. Since xterm only shows what the PTY
// echoes back, the output appearing at all proves a live shell.
test('terminal: an invalid configured shell falls back instead of failing', async () => {
  const dir = makeTempUserDataDir();
  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({ version: 1, terminal: { defaultShell: '/no/such/shell-xyz' } }),
  );
  const { app, page } = await launchApp({ userDataDir: dir });
  try {
    await page.getByRole('button', { name: 'Terminal' }).click();
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 10_000 });

    await page.locator('.xterm-screen').click();
    await page.keyboard.type('echo fallbackok');
    await page.keyboard.press('Enter');

    await expect(page.locator('.xterm')).toContainText('fallbackok', {
      timeout: 10_000,
    });
  } finally {
    await app.close();
  }
});

// Copy/paste through the right-click menu and the OS clipboard (Electron's
// clipboard module, reachable from app.evaluate in the main process).
test('terminal: context menu copy/paste round-trips through the OS clipboard', async () => {
  const { app, page } = await launchApp();
  try {
    await page.getByRole('button', { name: 'Terminal' }).click();
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 10_000 });
    const screen = page.locator('.xterm-screen');

    // Paste: seed the clipboard, paste via the menu, and see the text land at
    // the prompt (the shell echoes the pasted input back through the PTY).
    await app.evaluate(({ clipboard }) => clipboard.writeText('marudesk_paste_tok'));
    await screen.click();
    await screen.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Paste' }).click();
    await expect(page.locator('.xterm')).toContainText('marudesk_paste_tok', {
      timeout: 10_000,
    });

    // Copy: select everything via the menu, copy via the menu, read it back off
    // the OS clipboard.
    await screen.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Select All' }).click();
    await screen.click({ button: 'right' });
    const copyItem = page.getByRole('menuitem', { name: 'Copy' });
    await expect(copyItem).toBeEnabled();
    await copyItem.click();

    const clip = await app.evaluate(({ clipboard }) => clipboard.readText());
    expect(clip).toContain('marudesk_paste_tok');
  } finally {
    await app.close();
  }
});

// The find bar opens from both the context menu and the keyboard shortcut, and
// closes on Esc.
test('terminal: find bar opens via the menu and Ctrl/Cmd+F, closes on Esc', async () => {
  const { app, page } = await launchApp();
  try {
    await page.getByRole('button', { name: 'Terminal' }).click();
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 10_000 });
    const screen = page.locator('.xterm-screen');
    const find = page.getByPlaceholder('Find');

    await screen.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Find' }).click();
    await expect(find).toBeVisible();
    await find.press('Escape');
    await expect(find).toBeHidden();

    await screen.click();
    await page.keyboard.press('ControlOrMeta+f');
    await expect(find).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(find).toBeHidden();
  } finally {
    await app.close();
  }
});
