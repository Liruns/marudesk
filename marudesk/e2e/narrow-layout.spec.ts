import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/app';
import { openTaskDockChat, seedGraph } from './helpers/mission-control';

/**
 * The Instrument Dock's max-width clamp must reserve the 60px InstrumentRail (and
 * keep the stage ≥3rem), so on a narrow window the row never overflows and the
 * stage is never crushed to zero (DESIGN.md §8). The app enforces minWidth 1024,
 * so we verify the clamp *value* (true at any size) rather than relying on
 * shrinking the window past where it bites.
 */
test('instrument dock clamp reserves the rail', async () => {
  const { app, page } = await launchApp();
  try {
    await seedGraph(page, {
      goal: 'Ship the login page',
      tasks: [{ id: 't1', title: 'Build the login form', intent: 'Email + password fields' }],
    });
    await openTaskDockChat(page, 't1'); // dock opens (aside, role=complementary)

    const dock = page.getByRole('complementary', { name: 'Task instrument dock' });
    // The browser may reorder calc() terms, so assert the reservations are present
    // rather than an exact string: the rail (60px) + the minimum stage (3rem).
    const maxWidth = (await dock.evaluate((el) => (el as HTMLElement).style.maxWidth)).replace(/\s+/g, '');
    expect(maxWidth).toContain('100vw');
    expect(maxWidth).toContain('60px');
    expect(maxWidth).toContain('3rem');

    // And the rail + stage are both really on-screen alongside the open dock.
    const rail = page.getByRole('navigation', { name: /Instruments|도구/ });
    expect(Math.round((await rail.boundingBox())!.width)).toBe(60);
    const stage = page.locator('[data-stage-region]');
    expect((await stage.boundingBox())!.width).toBeGreaterThanOrEqual(48);
  } finally {
    await app.close();
  }
});
