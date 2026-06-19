import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/app';

/**
 * Chat CLI v2 (docs/chat-cli-tui-design.md §6/§8): the "AI Chat (CLI)" terminal
 * tab and the chat drawer are BOTH always available — there is no chat-surface
 * setting routing between them. The Home launcher card opens the CLI tab whose
 * PTY runs the bundled CLI against the loopback companion. The CLI prints its
 * banner only AFTER /health succeeds, so the banner showing up in xterm proves
 * the whole chain: companion listener up → terminal profile spawn
 * (ELECTRON_RUN_AS_NODE + dist-electron/chat-cli.mjs) → bearer auth over the
 * injected env → TUI boot.
 */

test('cli chat: the Home launcher opens the CLI terminal tab', async () => {
  const { app, page } = await launchApp();
  try {
    // The first-run guide hides the launcher grid; mark it seen and remount.
    await page.evaluate(() => localStorage.setItem('marudesk.onboarding.guide.v1', '1'));
    await page.reload();

    await page.getByRole('button', { name: 'AI Chat (CLI)' }).first().click();

    // The tab strip shows the dedicated CLI tab (not a plain Terminal).
    await expect(page.getByText('AI Chat (CLI)').first()).toBeVisible({ timeout: 10_000 });

    // The PTY hosts the CLI: its TUI banner lands in xterm once it authenticated
    // against the companion bridge. The banner tagline ("agentic chat · terminal
    // client") is the version-independent proof the TUI booted (the plain-mode
    // "marudesk chat" connect line never shows in the boxed TUI banner).
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.xterm')).toContainText('agentic chat', {
      timeout: 15_000,
    });
  } finally {
    await app.close();
  }
});

test('cli chat: the chat toggle opens the context drawer alongside', async () => {
  const { app, page } = await launchApp();
  try {
    await page.getByRole('button', { name: 'Show context panel' }).click();
    // The drawer (complementary region) opens; no CLI terminal tab appears.
    await expect(page.getByRole('complementary', { name: 'Context cart' })).toBeVisible({
      timeout: 10_000,
    });
    // No CLI *terminal tab* was spawned — scope to the tab strip, since the Home
    // launcher grid itself carries an "AI Chat (CLI)" card (its own affordance).
    await expect(page.getByRole('tab', { name: /AI Chat \(CLI\)/ })).toHaveCount(0);
  } finally {
    await app.close();
  }
});
