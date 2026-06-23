import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/app';
import { openTaskDockChat, seedGraph } from './helpers/mission-control';

/**
 * A long, unbroken task title in the per-task chat's "Briefed on: {task}" subtitle
 * must wrap inside the dock (break-words) — not overflow its centered container and
 * spill out of the dock's left edge into the stage (the bug this guards).
 */
test('dock chat subtitle does not overflow the dock with a long title', async () => {
  const { app, page } = await launchApp();
  try {
    const longTitle = 'Build ' + 'Supercalifragilisticexpialidocious'.repeat(3);
    await seedGraph(page, {
      goal: 'Ship auth',
      tasks: [{ id: 't1', title: longTitle, intent: 'x' }],
    });
    await openTaskDockChat(page, 't1');
    await page.waitForTimeout(400);

    const dock = page.getByRole('complementary', { name: 'Task instrument dock' });
    const subtitle = page.getByText(/^Briefed on:/);
    const dockBox = await dock.boundingBox();
    const subBox = await subtitle.boundingBox();
    expect(dockBox).not.toBeNull();
    expect(subBox).not.toBeNull();
    // The subtitle stays within the dock horizontally (a 2px tolerance for AA).
    expect(subBox!.x).toBeGreaterThanOrEqual(dockBox!.x - 2);
    expect(subBox!.x + subBox!.width).toBeLessThanOrEqual(dockBox!.x + dockBox!.width + 2);
  } finally {
    await app.close();
  }
});
