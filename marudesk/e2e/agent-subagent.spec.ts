import { test, expect } from '@playwright/test';
import type { AgentChatState } from '../shared/agent';
import { launchApp } from './helpers/app';
import { dockThreadId, emitToThread, openTaskDockChat, seedGraph } from './helpers/mission-control';

/**
 * Mission Control: the agent chat lives in the per-task Instrument Dock, so this
 * spec seeds a graph and selects a task to open the dock chat, then pushes a
 * synthetic snapshot to that task's bound thread (no real LLM). The subagent tool
 * card renders the same way it did in the old launcher chat — only the entry point
 * changed. Mirrors agent.spec's 'file changes render after the turn'.
 */

test('agent: subagent tool card shows child task, model, and result', async () => {
  const { app, page } = await launchApp();
  try {
    await seedGraph(page, { tasks: [{ id: 't1', title: 'Inspect agent tool plumbing' }] });
    const d = await openTaskDockChat(page, 't1');
    const threadId = await dockThreadId(page);

    await emitToThread(app, threadId, chatStateWithSubagentTool());

    const subagentCard = d.getByRole('button', { name: /Subagent/ });
    await expect(subagentCard).toBeVisible();
    await subagentCard.click();

    await expect(d.getByText('Task: inspect agent tool plumbing')).toBeVisible();
    await expect(d.getByText('Provider/model: ollama / qwen2.5-coder')).toBeVisible();
    await expect(d.getByText('child report: spawn wiring is visible')).toBeVisible();
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
