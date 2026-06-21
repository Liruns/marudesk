import { test, expect, type Page } from '@playwright/test';
import { launchApp, dismissHomeGuide } from './helpers/app';

/**
 * Onboarding tour anchors (src/features/tour). After the Mission Control redesign
 * the tour teaches the MC model — summon anything with ⌘K, set a goal → it becomes
 * the Task graph, manage workspaces, review the Flight Log — and each non-intro
 * step anchors to a real `data-tour` element on the current chrome. The previous
 * anchors (workspace-rail / tabs / activity-bar) no longer exist, so the tour used
 * to spotlight nothing; this spec pins every anchor the steps reference to a real,
 * visible element so a future chrome change that drops one fails loudly here.
 *
 * Seeds a one-task graph so the goal panel and the (graph-gated) Flight Log button
 * are present. No AI provider is needed.
 */

const GOAL = 'Ship the login page';

/** Seed a one-task graph so the goal panel + Flight Log button render. */
async function seedGraph(page: Page): Promise<void> {
  await page.evaluate((goal) => {
    const graph = {
      id: 'wg_tour',
      goal,
      tasks: [
        {
          id: 't1',
          title: 'Build the login form',
          intent: '',
          kind: 'work',
          status: 'planned',
          executor: { type: 'agent', ref: 'agent' },
          inputs: [],
          outputs: [],
          acceptance: [],
        },
      ],
      edges: [],
      createdAt: 1,
      updatedAt: 1,
    };
    localStorage.setItem(
      'maru.workgraph.v1',
      JSON.stringify({ graph, pos: { t1: { x: 200, y: 200 } } }),
    );
  }, GOAL);
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await dismissHomeGuide(page);
}

test('tour: every step anchors to a real Mission Control element', async () => {
  const { app, page } = await launchApp();
  try {
    await seedGraph(page);

    // The rewritten TOUR_STEPS point at these MC anchors (see src/features/tour/
    // steps.ts). Each must resolve to a real, visible element — otherwise the
    // Tour's measure() returns null and the step spotlights nothing.
    await expect(page.locator('[data-tour="command-palette"]')).toBeVisible();
    await expect(page.locator('[data-tour="goal"]')).toBeVisible();
    await expect(page.locator('[data-tour="workspace"]')).toBeVisible();
    await expect(page.locator('[data-tour="flight-log"]')).toBeVisible();
  } finally {
    await app.close();
  }
});
