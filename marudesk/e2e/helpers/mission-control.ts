import { expect, type ElectronApplication, type Page } from '@playwright/test';
import type { AgentChatState } from '../../shared/agent';
import { dismissHomeGuide } from './app';

/**
 * Mission Control test helpers. The redesign made the Task graph the only home:
 * the agent chat lives in the per-task Instrument Dock, and browser/editor/terminal
 * open as instruments summoned from a task's resources. These helpers seed a graph
 * and drive those new entry points so specs that used to open the chat/editor via
 * the (removed) home launcher / tabs / drawer can target the real surface.
 */

export type SeedResource = { id: string; kind: 'code' | 'doc' | 'url' | 'term' | 'db'; uri: string; label?: string };
export type SeedTask = {
  id: string;
  title: string;
  intent?: string;
  status?: 'planned' | 'running' | 'blocked' | 'done' | 'failed' | 'needs_review';
  outputs?: SeedResource[];
};

/** Seed a Task graph into the persisted store, then reload so Mission Control renders it. */
export async function seedGraph(
  page: Page,
  opts: { goal?: string; tasks: SeedTask[] },
): Promise<void> {
  await page.evaluate((o) => {
    const tasks = o.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      intent: t.intent ?? '',
      kind: 'work',
      status: t.status ?? 'planned',
      executor: { type: 'agent', ref: 'agent' },
      inputs: [],
      outputs: t.outputs ?? [],
      acceptance: [],
    }));
    const pos: Record<string, { x: number; y: number }> = {};
    tasks.forEach((t, i) => {
      pos[t.id] = { x: 160 + i * 300, y: 140 };
    });
    const graph = {
      id: 'wg_e2e',
      goal: o.goal ?? 'E2E flight',
      tasks,
      edges: [],
      createdAt: 1,
      updatedAt: 1,
    };
    localStorage.setItem('maru.workgraph.v1', JSON.stringify({ graph, pos }));
  }, opts);
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await dismissHomeGuide(page);
}

/** The Instrument Dock aside (the per-task inspector + chat). */
export function dock(page: Page) {
  return page.getByLabel('Task instrument dock');
}

/**
 * Select a task node, opening its Instrument Dock, and wait for the per-task chat
 * composer — which only mounts once that task's own agent thread is acquired.
 * Returns the dock locator so a caller can scope assertions to the chat.
 */
export async function openTaskDockChat(page: Page, taskId: string) {
  await page.locator(`[data-task-node="${taskId}"] [data-task-header]`).click();
  const d = dock(page);
  await expect(d.getByLabel('Agent prompt')).toBeVisible();
  return d;
}

/**
 * The active agent thread the dock chat is bound to. The dock acquires its thread
 * under the active workspace (the system workspace on a fresh launch, else global),
 * so try the system scope first and fall back to the global one.
 */
export async function dockThreadId(page: Page): Promise<string> {
  for (const ws of ['system', undefined] as const) {
    const threads = await page.evaluate(
      (w) => window.marudesk.invoke('agent:list-threads', w ? { workspaceId: w } : {}),
      ws,
    );
    const active = (threads as { id: string; active: boolean }[]).find((t) => t.active);
    if (active) return active.id;
  }
  throw new Error('no active dock thread found');
}

/** Push a synthetic chat snapshot to a specific thread (the dock chat is thread-bound). */
export async function emitToThread(
  app: ElectronApplication,
  threadId: string,
  state: AgentChatState,
): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, payload) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error('no main window');
      win.webContents.send('agent:thread-event', payload);
    },
    { threadId, state },
  );
}

/**
 * Summon a task's resource as a full-area instrument (browser / editor / terminal):
 * select the node, then click its resource chip in the inspector. Resolves once the
 * instrument stage's "Graph" back affordance is present.
 */
export async function openInstrumentFromTask(
  page: Page,
  taskId: string,
  resourceLabel: string,
): Promise<void> {
  await page.locator(`[data-task-node="${taskId}"] [data-task-header]`).click();
  await dock(page).getByRole('button', { name: resourceLabel }).click();
  await expect(page.getByRole('button', { name: 'Graph' })).toBeVisible();
}

/**
 * Open the ⌘K command palette and run a command by its visible label — the way
 * Mission Control opens surfaces that aren't a task Resource (Settings, AI Chat,
 * CLI chat, a new editor, a blank web tab). Each summons the surface as a full-area
 * instrument, so callers can then assert on it / use the "Graph" back affordance.
 */
export async function runCommand(page: Page, label: string): Promise<void> {
  await page.getByRole('button', { name: 'Command palette' }).click();
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await palette.getByRole('button', { name: label, exact: true }).click();
  await expect(palette).toBeHidden();
}
