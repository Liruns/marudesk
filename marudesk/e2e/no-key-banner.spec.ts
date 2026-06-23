import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/app';
import { runCommand } from './helpers/mission-control';

/**
 * Sending with no API key must surface exactly ONE "No API key" indicator — the
 * persistent ProviderKeyNudge. The send path used to ALSO set a transient
 * localError banner with the same message, stacking two identical warnings. The
 * draft is preserved so the user can add a key and retry.
 */
test('no duplicate "No API key" banner on a keyless send', async () => {
  const { app, page } = await launchApp();
  try {
    await runCommand(page, 'New AI Chat');
    const ta = page.getByPlaceholder(/Ask the agent/);
    await ta.fill('hello without a key');
    await ta.press('Enter');
    await page.waitForTimeout(600);

    await expect(page.getByText(/No API key/i)).toHaveCount(1);
    // Draft is kept for retry.
    await expect(ta).toHaveValue('hello without a key');
  } finally {
    await app.close();
  }
});
