import { test, expect, type Page } from '@playwright/test';
import { launchApp, dismissHomeGuide } from './helpers/app';

/**
 * Mission Control — the app's only home (docs/mission-control-redesign.md). A goal
 * is a Task graph; selecting a node opens that task's Instrument Dock, and the
 * dock's chat is scoped to the task's OWN agent thread (Phase 2b: "you talk to the
 * task, not a global bot"). The Flight Log gathers every task's conversation so
 * cross-node context isn't lost.
 *
 * Seeds a graph and drives select → dock → flight log. No AI provider is needed:
 * selecting a task only spins up an empty agent thread (agent:new-thread), so the
 * dock chat and the flight log render without any key configured.
 */

const GOAL = 'Ship the login page';
const TASK_TITLE = 'Build the login form';

/** Seed a one-task graph into the persisted store, then reload so it renders. */
async function seedGraph(page: Page): Promise<void> {
  await page.evaluate(
    ({ goal, title }) => {
      const graph = {
        id: 'wg_e2e',
        goal,
        tasks: [
          {
            id: 't1',
            title,
            intent: 'Create the form with email + password fields',
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
        JSON.stringify({ graph, pos: { t1: { x: 200, y: 160 } } }),
      );
    },
    { goal: GOAL, title: TASK_TITLE },
  );
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await dismissHomeGuide(page);
}

test('mission control: selecting a task opens its dock chat and the flight log lists it', async () => {
  const { app, page } = await launchApp();
  try {
    await seedGraph(page);

    // The graph home renders the seeded flight (goal in the title bar) + the node.
    await expect(page.locator('[data-stage="workgraph"]')).toBeVisible();
    await expect(page.getByText(GOAL)).toBeVisible();
    const node = page.locator('[data-task-node="t1"]');
    await expect(node).toBeVisible();

    // Selecting the node opens the Instrument Dock: the supervision inspector (the
    // Implement button is unique to it) plus the per-task chat. The composer only
    // mounts once the task's own thread is acquired, so its presence proves the
    // Phase 2b binding fired.
    await node.locator('[data-task-header]').click();
    await expect(page.getByRole('button', { name: 'Implement' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Agent prompt' })).toBeVisible();

    // The Flight Log gathers the task's conversation in one place and can jump back
    // to it. Once a task owns a thread it is listed here.
    await page.getByRole('button', { name: 'Flight log' }).click();
    const dialog = page.getByRole('dialog', { name: 'Flight log' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(TASK_TITLE)).toBeVisible();

    // "Open" jumps to the task and closes the log.
    await dialog.getByRole('button', { name: 'Open' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'Implement' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('mission control: the flight log moves focus inside on open and restores it on close', async () => {
  const { app, page } = await launchApp();
  try {
    await seedGraph(page);

    // Open a task so the flight log has a conversation to list (and a focusable
    // control inside the card).
    const node = page.locator('[data-task-node="t1"]');
    await expect(node).toBeVisible();
    await node.locator('[data-task-header]').click();
    await expect(page.getByRole('button', { name: 'Implement' })).toBeVisible();

    const trigger = page.getByRole('button', { name: 'Flight log' });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Flight log' });
    await expect(dialog).toBeVisible();

    // aria-modal: focus is moved into the dialog on open (not left on the trigger
    // behind the backdrop).
    const focusInsideDialog = await dialog.evaluate(
      (el) => el.contains(document.activeElement) || el === document.activeElement,
    );
    expect(focusInsideDialog).toBe(true);

    // Closing with Escape restores focus to the triggering button.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  } finally {
    await app.close();
  }
});
