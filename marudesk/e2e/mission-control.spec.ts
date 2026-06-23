import { test, expect, type Page } from '@playwright/test';
import { launchApp, dismissHomeGuide } from './helpers/app';
import { runCommand } from './helpers/mission-control';

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

    // Selecting the node opens the Instrument Dock: the supervision inspector (its
    // exact "Implement" button — matched with exact:true to disambiguate from the
    // chat's "Implement this task" first-move suggestion) plus the per-task chat.
    // The composer only mounts once the task's own thread is acquired, so its
    // presence proves the Phase 2b binding fired.
    await node.locator('[data-task-header]').click();
    await expect(page.getByRole('button', { name: 'Implement', exact: true })).toBeVisible();
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
    await expect(page.getByRole('button', { name: 'Implement', exact: true })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('mission control: regenerating over an existing graph confirms before replacing it', async () => {
  const { app, page } = await launchApp();
  try {
    await seedGraph(page);
    const node = page.locator('[data-task-node="t1"]');
    await expect(node).toBeVisible();

    // A new goal + Enter (the exact stray-keystroke this guards) must NOT wipe the
    // existing graph on the first press: it arms a confirm (the same two-step guard
    // as Clear), so manual edits, criteria, and node positions can't be lost.
    const goalBox = page.getByRole('textbox', { name: 'Goal' });
    await goalBox.fill('A different goal');
    await goalBox.press('Enter');
    await expect(page.getByText(/Press Generate again to confirm/i)).toBeVisible();
    await expect(node).toBeVisible(); // original task intact — first press destroyed nothing

    // The confirming second press replaces the graph (offline sample, no provider
    // needed): the original task is gone, proving the destructive action is reachable
    // — just gated behind the confirm.
    await goalBox.press('Enter');
    await expect(node).toBeHidden();
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
    await expect(page.getByRole('button', { name: 'Implement', exact: true })).toBeVisible();

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

test('mission control: the ⌘K palette runs an action verb (Toggle Flight Log)', async () => {
  const { app, page } = await launchApp();
  try {
    // Graph-gated: with no flight (graph) the command is absent, matching the
    // title-bar FlightLogButton (which returns null) so the two entry points agree.
    await page.getByRole('button', { name: 'Command palette' }).click();
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();
    await expect(palette.getByRole('button', { name: 'Toggle Flight Log', exact: true })).toHaveCount(0);
    // "Return to Graph" is likewise hidden on the bare graph: with no instrument
    // hosted there is nothing to close, so the command would be a silent no-op.
    await expect(palette.getByRole('button', { name: 'Return to Graph', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();

    await seedGraph(page);

    // The palette now lists action verbs alongside the "Open…" surfaces. Running
    // "Toggle Flight Log" delegates to the flight-log store and reveals the overlay.
    const dialog = page.getByRole('dialog', { name: 'Flight log' });
    await expect(dialog).toBeHidden();

    await runCommand(page, 'Toggle Flight Log');
    await expect(dialog).toBeVisible();
  } finally {
    await app.close();
  }
});

test('mission control: reopening a closed tab hosts it as a visible instrument', async () => {
  const { app, page } = await launchApp();
  try {
    // Seed a web tab straight through the tabs IPC (NOT the instrument store), then
    // host it via the tab switcher — the proven path in tab-palette.spec. about:blank
    // is recorded on close (only maru://newtab is skipped), so it becomes reopenable.
    const id = await page.evaluate(() =>
      window.marudesk.invoke('browser:tabs-new', { kind: 'web', url: 'about:blank' }),
    );
    expect(typeof id).toBe('string');

    // Host the seeded tab as the full-area instrument by picking it in the tab
    // switcher (Ctrl/Cmd+Shift+A). Typing also waits out the browser:tabs-new
    // coalesced push, so the matching row is present before Enter (no empty-results
    // race where Enter would be a no-op).
    await page.keyboard.press('Control+Shift+A');
    const switcher = page.getByRole('dialog', { name: 'Search tabs' });
    await expect(switcher).toBeVisible();
    await page.keyboard.type('blank');
    await expect(switcher.getByText('about:blank').first()).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('instrument-kind')).toHaveText('Web');

    // "Graph" closes the hosted tab (recording it on the closed-tab stack) and
    // returns to the work graph — no instrument is hosted now.
    await page.getByRole('button', { name: 'Graph', exact: true }).click();
    await expect(page.locator('[data-stage="workgraph"]')).toBeVisible();
    await expect(page.getByTestId('instrument-kind')).toHaveCount(0);

    // The ⌘K "Reopen Closed Tab" command must REOPEN the web tab AND host it as the
    // full-area instrument (before the fix it reopened in main but was never hosted,
    // so a native view painted over the graph with no chrome). The "Graph" back
    // affordance confirms the instrument chrome is present.
    await runCommand(page, 'Reopen Closed Tab');
    await expect(page.getByTestId('instrument-kind')).toHaveText('Web');
    await expect(page.getByRole('button', { name: 'Graph', exact: true })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('mission control: Ctrl+N opens a visible editor instrument (no orphan tab)', async () => {
  const { app, page } = await launchApp();
  try {
    await seedGraph(page);

    // The Task graph is the home; nothing is hosted yet.
    await expect(page.locator('[data-stage="workgraph"]')).toBeVisible();
    await expect(page.getByTestId('instrument-kind')).toHaveCount(0);

    // Ctrl+N must summon a NEW editor AS the full-area instrument — not create an
    // invisible, never-hosted tab. Focus the graph stage first so the shortcut
    // isn't swallowed by an editable field.
    await page.locator('[data-stage="workgraph"]').click();
    await page.keyboard.press('Control+KeyN');
    await expect(page.getByTestId('instrument-kind')).toHaveText('Editor');
  } finally {
    await app.close();
  }
});
