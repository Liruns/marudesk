import { test, expect, type ElectronApplication } from '@playwright/test';
import type { AgentChatState } from '../shared/agent';
import { launchApp } from './helpers/app';

test('agent: subagent tool card shows child task, model, and result', async () => {
  const { app, page } = await launchApp();
  try {
    await page.getByRole('button', { name: /AI Chat/ }).click();

    await emitAgentState(app, chatStateWithSubagentTool());
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
    pendingQuestions: null,
    usage: { inputTokens: 0, outputTokens: 0, contextTokens: 0 },
    error: null,
    activeSessionId: null,
    endNote: null,
  };
}

async function emitAgentState(app: ElectronApplication, state: AgentChatState): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, payload) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error('Main window not found');
      win.webContents.send('agent:event', payload);
    },
    state,
  );
}
