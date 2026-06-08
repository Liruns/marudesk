import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/app';

/**
 * Design-benchmark polish (N4): the app wraps its React root in
 * <LucideProvider strokeWidth={1.5}> so every Lucide icon uses the lighter 1.5
 * stroke by default. Verify a real rendered icon carries that stroke-width
 * (lucide stamps it as an attribute from context).
 */
test('icons: Lucide stroke defaults to 1.5 app-wide', async () => {
  const { app, page } = await launchApp();
  try {
    const icon = page.locator('svg.lucide').first();
    await expect(icon).toBeVisible();
    await expect(icon).toHaveAttribute('stroke-width', '1.5');
  } finally {
    await app.close();
  }
});
