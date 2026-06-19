import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import type { AgentChatState } from '../shared/agent';
import { launchApp } from './helpers/app';

test('agent: subagent tool card shows child task, model, and result', async () => {
  const { app, page } = await launchApp();
  try {
    // The Home grid has two chat launchers ("AI Chat" + "AI Chat (CLI)"); target
    // the agent one by its description so the name isn't ambiguous.
    await page.getByRole('button', { name: /AI Chat Agent/ }).click();

    await emitAgentState(app, page, chatStateWithSubagentTool());
    const main = page.getByRole('main');
    const subagentCard = main.getByRole('button', { name: /Subagent/ });
    await expect(subagentCard).toBeVisible();
    await subagentCard.click();

    await expect(main.getByText('Task: inspect agent tool plumbing')).toBeVisible();
    await expect(main.getByText('Provider/model: ollama / qwen2.5-coder')).toBeVisible();
    await expect(main.getByText('child report: spawn wiring is visible')).toBeVisible();
  } finally {
    await app.close();
  }
});

function chatStateWithSubagentTool(): AgentChatState {
  return {
    turnId: 'turn-subagent-card',
    status: 'completed',
    messages: [
      {
        id: 'message-subagent-card',
        role: 'assistant',
        parts: [
          {
            type: 'tool',
            call: {
              id: 'call-subagent-card',
              name: 'spawn_subagent',
              input: {
                task: 'inspect agent tool plumbing',
                provider: 'ollama',
                model: 'qwen2.5-coder',
              },
              state: 'ok',
              resultText:
                'Task: inspect agent tool plumbing\nProvider/model: ollama / qwen2.5-coder\nStatus: completed\n\nResult:\nchild report: spawn wiring is visible',
            },
          },
        ],
        timestamp: 1,
      },
    ],
    edits: [],
    pendingApproval: null,
    approvalQueue: [],
    pendingQuestions: null,
    usage: { inputTokens: 0, outputTokens: 0, contextTokens: 0 },
    error: null,
    activeSessionId: null,
    endNote: null,
    background: [],
    orchestration: [],
    plan: null,
    approvalMode: 'ask',
  };
}

/**
 * Emit agent state to the thread bound to the default (unscoped) AI Chat tab.
 * Every agent tab now owns its own thread (bound via `agent:thread-event`), so a
 * plain `agent:event` is no longer received by thread-bound panes. Wait for the
 * composer (the tab's thread is bound), resolve its active thread from the system
 * workspace, then emit to that thread. Mirrors agent.spec's helper.
 */
async function emitAgentState(
  app: ElectronApplication,
  page: Page,
  state: AgentChatState,
): Promise<void> {
  await expect(page.getByRole('main').getByLabel('Agent prompt')).toBeVisible();
  await page.waitForTimeout(50);
  const threads = await page.evaluate(() =>
    window.marudesk.invoke('agent:list-threads', { workspaceId: 'system' }),
  );
  const active = (threads as { id: string; active: boolean }[]).find((t) => t.active);
  if (!active) throw new Error('No active system-workspace thread found after tab was ready');
  await app.evaluate(
    ({ BrowserWindow }, payload) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error('Main window not found');
      win.webContents.send('agent:thread-event', payload);
    },
    { threadId: active.id, state },
  );
}
