import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { launchApp, makeTempUserDataDir } from './helpers/app';

/**
 * Chat CLI v2 (docs/chat-cli-tui-design.md §6/§8): with Settings → Agent →
 * Chat surface set to 'cli', the chat-open intent must open an "AI Chat (CLI)"
 * terminal tab whose PTY runs the bundled CLI against the loopback companion.
 * The CLI prints its banner only AFTER /health succeeds, so the banner showing
 * up in xterm proves the whole chain: companion listener up → terminal profile
 * spawn (ELECTRON_RUN_AS_NODE + dist-electron/chat-cli.mjs) → bearer auth over
 * the injected env → TUI boot.
 */

test('cli chat: the chat toggle opens the CLI terminal tab when chatSurface=cli', async () => {
  const dir = makeTempUserDataDir();
  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({ version: 1, agent: { chatSurface: 'cli' } }),
  );
  const { app, page } = await launchApp({ userDataDir: dir });
  try {
    await page.getByRole('button', { name: 'Show context panel' }).click();

    // The tab strip shows the dedicated CLI tab (not a plain Terminal).
    await expect(page.getByText('AI Chat (CLI)').first()).toBeVisible({ timeout: 10_000 });

    // The PTY hosts the CLI: its banner lands in xterm once it authenticated
    // against the companion bridge.
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.xterm')).toContainText('marudesk chat', {
      timeout: 15_000,
    });

    // Toggling again must FOCUS the existing CLI tab, not open a second one.
    await page.getByRole('button', { name: 'Show context panel' }).click();
    expect(await page.getByText('AI Chat (CLI)').count()).toBe(1);
  } finally {
    await app.close();
  }
});

test('cli chat: the default surface still opens the context drawer', async () => {
  const { app, page } = await launchApp();
  try {
    await page.getByRole('button', { name: 'Show context panel' }).click();
    // The drawer (complementary region) opens; no CLI terminal tab appears.
    await expect(page.getByRole('complementary', { name: 'Context cart' })).toBeVisible({
      timeout: 10_000,
    });
    expect(await page.getByText('AI Chat (CLI)').count()).toBe(0);
  } finally {
    await app.close();
  }
});
