import { test } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launchApp, type LaunchedApp } from './helpers/app';
import { dock, openTaskDockChat, runCommand, seedGraph } from './helpers/mission-control';

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
    await page.waitForTimeout(400); // let the dock finish sliding in before the shot
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
      await page.getByRole('button', { name: 'Graph', exact: true }).click({ timeout: 3000 });
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

/**
 * The second harness: the states the happy-path capture above never shows — what
 * a brand-new user sees, the empty home, every summonable instrument (with no
 * workspace open, which is itself a first-run reality), a narrow window, and a
 * long-goal / many-task graph. These are the surfaces where "what can the user
 * do here, and is it obvious?" actually gets answered. Each instrument relaunches
 * fresh so one bad state can't cascade into the next. Output: same .screens/ dir.
 */
test('capture onboarding, instruments, and edge states', async () => {
  test.setTimeout(220_000);
  fs.mkdirSync(OUT, { recursive: true });

  // A) First-run onboarding overlay — the very first thing a new user sees.
  {
    const l = await launchApp({ keepHomeGuide: true });
    try {
      await l.page.waitForTimeout(500);
      await shot(l.page, 'a1-first-run-guide');
    } finally {
      await l.app.close();
    }
  }

  // B) The steady-state empty home (guide dismissed, no graph) — is it obvious
  //    how to start? Plus a narrow window to check the title bar / Goal panel.
  {
    const l = await launchApp();
    try {
      await l.page.waitForTimeout(400);
      await shot(l.page, 'a2-empty-home');
      await l.app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows()[0];
        if (w) w.setSize(720, 820);
      });
      await l.page.waitForTimeout(500);
      await shot(l.page, 'a3-narrow-home');
    } finally {
      await l.app.close();
    }
  }

  // C) Every instrument the ⌘K palette can summon, each from a fresh launch with
  //    no workspace open (the real first-run condition). The embedded browser is
  //    a separate WebContentsView so a8 shows only its chrome — still the surface
  //    we judge.
  const instruments: ReadonlyArray<readonly [string, string]> = [
    ['New Editor', 'a4-editor'],
    ['New Terminal', 'a5-terminal'],
    ['Open Files', 'a6-files'],
    ['Search in Files', 'a7-search'],
    ['Source Control', 'a8-source-control'],
    ['New AI Chat', 'a9-ai-chat'],
    ['New CLI Chat', 'a10-cli-chat'],
    ['New Web Tab', 'a11-web'],
  ];
  for (const [label, name] of instruments) {
    const l = await launchApp();
    try {
      await runCommand(l.page, label);
      await l.page.waitForTimeout(700);
      await shot(l.page, name);
    } catch (err) {
      console.log(`[screens] instrument ${name} skip: ${(err as Error).message}`);
    } finally {
      await l.app.close();
    }
  }

  // D) Edge: a long goal + many tasks — node/body wrapping + canvas layout stress.
  {
    const l = await launchApp();
    try {
      await seedGraph(l.page, {
        goal: 'Ship a complete authentication system: email/password, OAuth (Google, GitHub, Apple), magic links, 2FA, password reset, session management, and rate limiting across web and mobile',
        tasks: Array.from({ length: 6 }, (_, i) => ({
          id: `t${i + 1}`,
          title: `Task ${i + 1}: build and verify the ${['login form', 'OAuth handshake', 'magic-link flow', '2FA enrolment', 'reset pipeline', 'rate limiter'][i]}`,
          intent: 'A reasonably detailed intent that exercises the node body text wrapping and line-clamp behavior when the description runs long.',
        })),
      });
      await l.page.waitForTimeout(800);
      await shot(l.page, 'a12-many-tasks');
    } finally {
      await l.app.close();
    }
  }
});
