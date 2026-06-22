import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/app';

/**
 * The always-visible instrument rail (src/features/work-graph/InstrumentRail.tsx)
 * — the persistent launcher restored after the Mission Control redesign buried
 * the staple tools behind ⌘K. Verifies the staples are reachable in one click and
 * that opening one lights up its rail entry (aria-pressed) so "you are here" is
 * obvious.
 */
test('instrument rail launches a tool and marks it active', async () => {
  const { app, page } = await launchApp();
  try {
    const rail = page.getByRole('navigation', { name: /Instruments|도구/ });
    await expect(rail).toBeVisible();

    // The staples the redesign hid are all one click away.
    for (const name of ['Chat', 'Web', 'Editor', 'Terminal', 'Git', 'Files', 'Search', 'Settings']) {
      await expect(rail.getByRole('button', { name: new RegExp(`^${name}$`) })).toBeVisible();
    }

    const editor = rail.getByRole('button', { name: /^Editor$/ });
    await expect(editor).toHaveAttribute('aria-pressed', 'false');
    await editor.click();
    // The editor instrument is now the full-area surface, and its rail entry is active.
    await expect(editor).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('Untitled-1').first()).toBeVisible();
  } finally {
    await app.close();
  }
});
