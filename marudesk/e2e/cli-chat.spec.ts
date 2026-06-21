import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/app';
import { runCommand } from './helpers/mission-control';

/**
 * Chat CLI v2 (docs/chat-cli-tui-design.md §6/§8). Mission Control has no Home
 * launcher / tab strip: the CLI chat is summoned from the ⌘K command palette as a
 * full-area terminal instrument ("New CLI Chat" → openInstrument('terminal',
 * { terminalProfile: 'agent-cli' })). The PTY runs the bundled CLI against the
 * loopback companion. The CLI prints its banner only AFTER /health succeeds, so
 * the banner showing up in xterm proves the whole chain: companion listener up →
 * terminal profile spawn (ELECTRON_RUN_AS_NODE + dist-electron/chat-cli.mjs) →
 * bearer auth over the injected env → TUI boot.
 */

test('cli chat: the command palette opens the CLI as a terminal instrument', async () => {
  const { app, page } = await launchApp();
  try {
    // ⌘K → "New CLI Chat" summons the dedicated CLI terminal as the full-area
    // instrument; "← Graph" is the proof the instrument stage took over the frame.
    await runCommand(page, 'New CLI Chat');
    await expect(page.getByRole('button', { name: 'Graph' })).toBeVisible({ timeout: 10_000 });

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
