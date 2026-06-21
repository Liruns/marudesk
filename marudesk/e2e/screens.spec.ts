import { test } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launchApp, type LaunchedApp } from './helpers/app';
import { dock, openTaskDockChat, seedGraph } from './helpers/mission-control';

/**
 * Not a real test — a screenshot harness. Launches the built app and captures
 * each Mission Control surface so we can eyeball the redesign: the Task graph
 * home, a selected task with its Instrument Dock, a summoned instrument
 * (Settings), the Flight Log overlay, and the ⌘K command palette. Renderer-only:
 * the embedded WebContentsView isn't in this page's DOM, but every surface here
 * is React chrome, which is exactly what we're judging.
 *
 * Run: npx playwright test screens   (after npm run build)
 * Output: marudesk/.screens/*.png
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '..', '.screens');

test.setTimeout(45_000);

async function shot(page: LaunchedApp['page'], name: string): Promise<void> {
  try {
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    console.log(`[screens] ${name}.png`);
  } catch (err) {
    console.log(`[screens] FAILED ${name}: ${(err as Error).message}`);
  }
}

test('capture UX surfaces', async () => {
  fs.mkdirSync(OUT, { recursive: true });
  let launched: LaunchedApp | null = null;
  try {
    launched = await launchApp();
    const { page } = launched;

    // Seed a Task graph so the home isn't empty: a goal with one task that owns
    // a couple of resources (so the dock inspector shows clickable chips).
    await seedGraph(page, {
      goal: 'Ship the login page',
      tasks: [
        {
          id: 't1',
          title: 'Build the login form',
          intent: 'Create the form with email + password fields',
          outputs: [{ id: 'r1', kind: 'url', uri: 'https://example.com', label: 'Preview' }],
        },
        {
          id: 't2',
          title: 'Wire the auth API',
          intent: 'Connect the form to the auth endpoint',
        },
      ],
    });
    await page.waitForTimeout(700); // let the graph + chrome settle

    // 1. Mission Control home — the Task graph (the app's only home).
    await shot(page, '01-task-graph-home');

    // 2. A selected task — its Instrument Dock opens with the per-task chat +
    //    resource chips. This is where supervision + agent conversation live.
    await openTaskDockChat(page, 't1');
    await shot(page, '02-task-dock');

    // 3. The Flight Log — every task's conversation gathered in one overlay.
    await page.getByRole('button', { name: 'Flight log' }).click();
    await page.waitForTimeout(300);
    await shot(page, '03-flight-log');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    // 4. The ⌘K command palette — the "summon anything" entry point for surfaces
    //    that aren't a task resource (Settings, AI Chat, terminal, editor, web).
    await page.getByRole('button', { name: 'Command palette' }).click();
    await page.waitForTimeout(300);
    await shot(page, '04-command-palette');

    // 5. Settings → AI Providers, summoned as a full-area instrument. The palette
    //    closes when a command runs, then we drill into the providers section.
    await page.getByRole('button', { name: 'Open Settings', exact: true }).click();
    await page.waitForTimeout(300);
    await shot(page, '05-settings');
    try {
      await page.getByRole('button', { name: 'AI Providers' }).click({ timeout: 3000 });
      await page.waitForTimeout(400);
      await shot(page, '06-settings-providers');
    } catch (err) {
      console.log(`[screens] providers nav skip: ${(err as Error).message}`);
    }
    try {
      await page.getByRole('button', { name: 'Appearance' }).click({ timeout: 3000 });
      await page.waitForTimeout(400);
      await shot(page, '07-settings-appearance');
    } catch (err) {
      console.log(`[screens] appearance skip: ${(err as Error).message}`);
    }

    // 6. Back to the graph from the instrument, then re-open the dock to confirm
    //    the steady-state inspector (the resource chip is the proof it rendered).
    try {
      await page.getByRole('button', { name: 'Graph' }).click({ timeout: 3000 });
      await page.waitForTimeout(300);
      await openTaskDockChat(page, 't1');
      await dock(page).getByRole('button', { name: 'Preview' }).waitFor({ timeout: 3000 });
      await shot(page, '08-task-dock-resources');
    } catch (err) {
      console.log(`[screens] dock-resources skip: ${(err as Error).message}`);
    }
  } finally {
    if (launched) await launched.app.close();
  }
});
