import { test, expect, type Page } from '@playwright/test';
import { launchApp } from './helpers/app';

/**
 * Settings → AI Providers UX: the "Get a key" deep links (catalog `apiKeyUrl`)
 * and the custom-endpoint quick-setup presets. External links open via the main
 * window's window-open handler (target="_blank" → safe-open), so here we assert
 * the href/target are wired — not that a browser actually launches.
 */

async function openProviders(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await page.getByRole('button', { name: 'AI Providers' }).click();
  await expect(page.getByRole('heading', { name: 'AI Providers' })).toBeVisible();
}

test('providers UI: a built-in provider deep-links to its API-key console', async () => {
  const { app, page } = await launchApp();
  try {
    await openProviders(page);
    // Expand Anthropic to reveal its key editor.
    await page.getByRole('button', { name: /Anthropic/ }).first().click();
    const link = page.locator('a[href="https://console.anthropic.com/settings/keys"]');
    await expect(link).toBeVisible();
    expect(await link.getAttribute('target')).toBe('_blank');
  } finally {
    await app.close();
  }
});

test('providers UI: a custom-endpoint preset prefills the form', async () => {
  const { app, page } = await launchApp();
  try {
    await openProviders(page);
    // Open the add-endpoint form (only one "Add endpoint" button until it opens).
    await page.getByRole('button', { name: 'Add endpoint' }).click();

    // A cloud preset prefills the base URL and surfaces its key-issuance link.
    await page.locator('[data-preset="moonshot"]').click();
    await expect(page.getByLabel('Base URL')).toHaveValue('https://api.moonshot.ai/v1');
    await expect(
      page.locator('a[href="https://platform.moonshot.ai/console/api-keys"]'),
    ).toBeVisible();

    // A local preset is keyless and points at loopback (no key link).
    await page.locator('[data-preset="lmstudio"]').click();
    await expect(page.getByLabel('Base URL')).toHaveValue('http://localhost:1234/v1');
    await expect(
      page.locator('a[href="https://platform.moonshot.ai/console/api-keys"]'),
    ).toHaveCount(0);
  } finally {
    await app.close();
  }
});
