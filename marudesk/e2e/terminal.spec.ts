import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/app';

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
