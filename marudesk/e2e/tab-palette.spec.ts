import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/app';

/**
 * The tab switcher palette (Ctrl/Cmd+Shift+A) used to only `activateTab` in main
 * and — outside the legacy canvas — leave the Shell rendering the work graph. In
 * Mission Control that meant the picked tab never showed: a web view painted over
 * the graph with no chrome, or a feature tab showed nothing at all. The palette
 * must now also host the chosen tab as the full-area instrument, mirroring the
 * ⌘K command palette's openInstrument path.
 */
test('tab palette hosts the picked tab as a Mission Control instrument', async () => {
  const { app, page } = await launchApp();
  try {
    // Seed two web tabs straight through the tabs IPC — NOT via the instrument
    // store — so they exist while the Shell is still on the work graph (no tab is
    // hosted). This is the exact gap the fix closes: a picked-but-unhosted tab.
    const ids = await page.evaluate(async () => {
      const a = await window.marudesk.invoke('browser:tabs-new', {
        kind: 'web',
        url: 'about:blank',
      });
      const b = await window.marudesk.invoke('browser:tabs-new', {
        kind: 'web',
        url: 'about:blank',
      });
      return { a, b };
    });
    expect(typeof ids.a).toBe('string');
    expect(typeof ids.b).toBe('string');

    // The work graph is the home — no instrument is hosted yet.
    await expect(page.locator('[data-stage="workgraph"]')).toBeVisible();

    // Open the tab switcher.
    await page.keyboard.press('Control+Shift+A');
    const dialog = page.getByRole('dialog', { name: 'Search tabs' });
    await expect(dialog).toBeVisible();

    // Filter to the seeded web tabs. Typing also waits out the `browser:tabs-new`
    // coalesced push: the palette renders from the RENDERER tab store, which is
    // populated asynchronously after the IPC resolves, so the matching row only
    // appears once the seeded tabs have actually propagated. Asserting the row is
    // visible before pressing Enter makes the pick deterministic (no empty-results
    // race where Enter would be a no-op).
    await page.keyboard.type('blank');
    await expect(dialog.getByText('about:blank').first()).toBeVisible();

    // Enter picks the highlighted (first) row — guaranteed to be a web tab.
    await page.keyboard.press('Enter');

    // The picked web tab is now hosted as the full-area instrument (it was
    // invisible before the fix), and the "← Graph" back affordance is present.
    await expect(page.getByTestId('instrument-kind')).toHaveText('Web');
    await expect(page.getByRole('button', { name: 'Graph' })).toBeVisible();
  } finally {
    await app.close();
  }
});

/**
 * A11y contract for the shared palette shell (PaletteOverlay): every palette is an
 * `aria-modal` dialog that must (a) expose the WAI-ARIA combobox/listbox/option
 * pattern so a screen reader hears the moving selection while DOM focus stays on
 * the search input, and (b) trap Tab so focus never escapes onto the title-bar
 * chrome behind the dimmed scrim. Asserted on the tab switcher as the representative
 * palette (the semantics are wired once in the shared shell, not per palette).
 */
test('tab palette exposes listbox semantics and traps Tab inside the dialog', async () => {
  const { app, page } = await launchApp();
  try {
    await page.evaluate(async () => {
      await window.marudesk.invoke('browser:tabs-new', { kind: 'web', url: 'about:blank' });
      await window.marudesk.invoke('browser:tabs-new', { kind: 'web', url: 'about:blank' });
    });

    await page.keyboard.press('Control+Shift+A');
    const dialog = page.getByRole('dialog', { name: 'Search tabs' });
    await expect(dialog).toBeVisible();

    // The input is a combobox that controls a listbox of option rows.
    const input = dialog.getByRole('combobox');
    await expect(input).toBeVisible();
    const listbox = dialog.getByRole('listbox');
    await expect(listbox).toBeVisible();

    // Filter to the seeded web tabs so option rows render, then arrow the selection.
    // Rows stay <button> (so the runCommand getByRole('button') helpers keep
    // matching); the option semantics ride on top via aria-selected + an id that
    // the combobox's aria-activedescendant points at. So target the row buttons
    // inside the listbox, not getByRole('option').
    await page.keyboard.type('blank');
    await expect(dialog.getByText('about:blank').first()).toBeVisible();
    const options = listbox.getByRole('button');
    await expect(options.first()).toHaveAttribute('aria-selected', 'true');

    // ArrowDown moves the active option; the combobox's aria-activedescendant must
    // point at the newly selected row (the announcement a screen reader reads).
    await page.keyboard.press('ArrowDown');
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(options.first()).toHaveAttribute('aria-selected', 'false');
    const activeId = await input.getAttribute('aria-activedescendant');
    expect(activeId).toBeTruthy();
    await expect(options.nth(1)).toHaveAttribute('id', activeId ?? '');

    // Tab must stay inside the aria-modal dialog (no escape to the chrome behind
    // the backdrop). After several Tabs, focus is still within the card.
    for (let i = 0; i < 5; i++) await page.keyboard.press('Tab');
    const focusTrapped = await dialog.evaluate(
      (el) => el.contains(document.activeElement) || el === document.activeElement,
    );
    expect(focusTrapped).toBe(true);
  } finally {
    await app.close();
  }
});
