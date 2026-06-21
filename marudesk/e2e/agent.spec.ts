import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { launchApp } from './helpers/app';
import { dock, dockThreadId, emitToThread, openTaskDockChat, seedGraph } from './helpers/mission-control';
import type { AgentChatState } from '../shared/agent';

/**
 * Agentic AI Chat (docs/agentic-chat-design.md). These never call a real LLM —
 * they verify the panel mounts, seeded renderer projections, snapshot IPC
 * round-trips, and the pre-turn validation guards reject cleanly. The full tool
 * loop is driven by the model, so it is exercised by hand / unit-covered, not in
 * CI.
 *
 * Mission Control: the chat lives in the per-task Instrument Dock (Phase 2b), so
 * the UI specs seed a graph and select a task to open it, rather than the (removed)
 * home launcher / context drawer.
 */

test('agent: chat mounts in the task dock when a task is selected', async () => {
  const { app, page } = await launchApp();
  try {
    await seedGraph(page, { tasks: [{ id: 't1', title: 'Wire the chat' }] });
    const d = await openTaskDockChat(page, 't1');
    // The per-task chat composer is the proof the dock chat mounted + bound a thread.
    await expect(d.getByLabel('Agent prompt')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('agent: snapshot IPC returns an idle, empty chat state', async () => {
  const { app, page } = await launchApp();
  try {
    const snap = await page.evaluate(() => window.marudesk.invoke('agent:snapshot'));
    expect(snap.status).toBe('idle');
    expect(snap.messages).toEqual([]);
    expect(snap.edits).toEqual([]);
    expect(snap.turnId).toBeNull();
  } finally {
    await app.close();
  }
});

test('agent: file changes render after the turn that produced them', async () => {
  const { app, page } = await launchApp();
  try {
    await seedGraph(page, { tasks: [{ id: 't1', title: 'Edit some files' }] });
    const d = await openTaskDockChat(page, 't1');
    const threadId = await dockThreadId(page);

    const state: AgentChatState = {
      turnId: null,
      status: 'completed',
      messages: [
        {
          id: 'u1',
          turnId: 'turn-1',
          role: 'user',
          parts: [{ type: 'text', text: 'First turn request' }],
          timestamp: 100,
        },
        {
          id: 'a1',
          turnId: 'turn-1',
          role: 'assistant',
          parts: [{ type: 'text', text: 'First turn done' }],
          timestamp: 200,
        },
        {
          id: 'u2',
          turnId: 'turn-2',
          role: 'user',
          parts: [{ type: 'text', text: 'Second turn request' }],
          timestamp: 300,
        },
        {
          id: 'a2',
          turnId: 'turn-2',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Second turn done' }],
          timestamp: 400,
        },
      ],
      edits: [
        {
          id: 'edit-1',
          turnId: 'turn-1',
          path: 'first_turn_change.txt',
          kind: 'create',
          before: null,
          after: 'first',
          status: 'applied',
          timestamp: 180,
        },
        {
          id: 'edit-2',
          turnId: 'turn-2',
          path: 'second_turn_change.txt',
          kind: 'create',
          before: null,
          after: 'second',
          status: 'applied',
          timestamp: 360,
        },
      ],
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

    await emitToThread(app, threadId, state);

    await expect(d.getByText('first_turn_change.txt')).toBeVisible();
    await expect(d.getByText('second_turn_change.txt')).toBeVisible();
    await expect(d.getByRole('button', { name: 'Keep' }).first()).toBeVisible();
    await expect(d.getByRole('button', { name: 'Revert' }).first()).toBeVisible();

    const body = await d.innerText();
    const firstAnswer = body.indexOf('First turn done');
    const firstChange = body.indexOf('first_turn_change.txt');
    const secondPrompt = body.indexOf('Second turn request');
    const secondAnswer = body.indexOf('Second turn done');
    const secondChange = body.indexOf('second_turn_change.txt');
    expect(firstAnswer).toBeGreaterThanOrEqual(0);
    expect(firstChange).toBeGreaterThan(firstAnswer);
    expect(firstChange).toBeLessThan(secondPrompt);
    expect(secondChange).toBeGreaterThan(secondAnswer);
  } finally {
    await app.close();
  }
});

test('agent: send is rejected without a workspace (no real LLM call)', async () => {
  const { app, page } = await launchApp();
  try {
    const res = await page.evaluate(() =>
      window.marudesk.invoke('agent:send', {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        prompt: 'do something',
        captures: [],
      }),
    );
    if (res.ok) throw new Error('expected the send to be rejected without a workspace');
    expect(typeof res.reason).toBe('string');
    expect(res.reason.length).toBeGreaterThan(0);
  } finally {
    await app.close();
  }
});

test('agent: Ollama is a keyless provider (ready without a stored key)', async () => {
  const { app, page } = await launchApp();
  try {
    const list = await page.evaluate(() => window.marudesk.invoke('secrets:list-providers'));
    const ollama = list.find((p) => p.id === 'ollama');
    expect(ollama).toBeTruthy();
    expect(ollama?.hasKey).toBe(true);
  } finally {
    await app.close();
  }
});

test('agent: send validates the payload shape', async () => {
  const { app, page } = await launchApp();
  try {
    // Empty prompt is rejected by the handler/loop, surfaced as a thrown invoke.
    const err = await page.evaluate(async () => {
      try {
        await window.marudesk.invoke('agent:send', {
          provider: 'anthropic',
          model: 'm',
          prompt: '',
          captures: [],
        });
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    });
    expect(err).toBeTruthy();
  } finally {
    await app.close();
  }
});

test('agent: snapshot carries activeSessionId, null when fresh (sessions §5-C)', async () => {
  const { app, page } = await launchApp();
  try {
    const snap = await page.evaluate(() => window.marudesk.invoke('agent:snapshot'));
    // The field exists on the contract and is null for a not-yet-saved chat.
    expect(snap.activeSessionId).toBeNull();
  } finally {
    await app.close();
  }
});

test('agent: session IPC round-trips — list / resume-missing / delete (§5-C)', async () => {
  const { app, page } = await launchApp();
  try {
    const list = await page.evaluate(() => window.marudesk.invoke('agent:list-sessions'));
    expect(Array.isArray(list)).toBe(true);
    // Resuming an unknown id is refused (not thrown) — the loop reads disk, finds
    // nothing, returns false.
    const resumed = await page.evaluate(() =>
      window.marudesk.invoke('agent:resume-session', { id: 'session-does-not-exist' }),
    );
    expect(resumed).toBe(false);
    // Deleting an unknown id is a best-effort no-op that still resolves a boolean.
    const deleted = await page.evaluate(() =>
      window.marudesk.invoke('agent:delete-session', { id: 'session-does-not-exist' }),
    );
    expect(typeof deleted).toBe('boolean');
  } finally {
    await app.close();
  }
});

test('agent: streaming transcript does not re-pin after a small upward scroll', async () => {
  const { app, page } = await launchApp();
  try {
    await seedGraph(page, { tasks: [{ id: 't1', title: 'Stream a long answer' }] });
    await openTaskDockChat(page, 't1');
    const threadId = await dockThreadId(page);

    const baseText = longAssistantText('scroll-regression-start');
    await emitToThread(app, threadId, chatStateWithAssistantText(baseText));
    const transcript = dock(page)
      .locator('.overflow-y-auto')
      .filter({ hasText: 'scroll-regression-start' })
      .first();
    await expect(transcript).toBeVisible();
    await expect
      .poll(async () => (await readScrollMetrics(transcript)).distanceFromBottom)
      .toBeLessThanOrEqual(1);

    const bottomTop = (await readScrollMetrics(transcript)).scrollTop;
    const box = await transcript.boundingBox();
    if (!box) throw new Error('Chat transcript box not found');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -24);
    await expect.poll(async () => (await readScrollMetrics(transcript)).scrollTop).toBeLessThan(bottomTop);

    await emitToThread(
      app,
      threadId,
      chatStateWithAssistantText(`${baseText}\n\nstreaming update after small scroll`),
    );
    await expect(dock(page).getByText('streaming update after small scroll')).toBeAttached();
    await nextPaint(page);

    const afterStreamTop = (await readScrollMetrics(transcript)).scrollTop;
    expect(afterStreamTop).toBeLessThan(bottomTop - 5);
  } finally {
    await app.close();
  }
});

test('agent: composer attaches a selected file, sends bounded content, and restores on failure', async () => {
  const attachmentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'marudesk-agent-attachment-'));
  const attachmentPath = path.join(attachmentDir, 'agent-attachment.txt');
  await fs.writeFile(attachmentPath, 'attached context', 'utf8');
  const { app, page } = await launchApp();
  try {
    await app.evaluate(({ ipcMain }) => {
      const g = globalThis as typeof globalThis & { __agentSendPayloads?: unknown[] };
      g.__agentSendPayloads = [];
      ipcMain.removeHandler('agent:send');
      ipcMain.handle('agent:send', (_event, payload) => {
        g.__agentSendPayloads?.push(payload);
        return { ok: false, reason: 'stubbed send failure' };
      });
    });
    await page.evaluate(() => {
      localStorage.setItem('marudesk.providers.selectedModelKey', 'ollama:qwen2.5-coder');
    });
    await seedGraph(page, { tasks: [{ id: 't1', title: 'Attach a file' }] });
    const d = await openTaskDockChat(page, 't1');

    await d.locator('input[aria-label="Attach files"]').setInputFiles(attachmentPath);
    await expect(d.getByText('agent-attachment.txt')).toBeVisible();
    await d.getByLabel('Agent prompt').fill('Review attached file');
    await d.getByRole('button', { name: 'Send' }).click();

    const payloads = await app.evaluate(() => {
      const g = globalThis as typeof globalThis & { __agentSendPayloads?: unknown[] };
      return g.__agentSendPayloads ?? [];
    });
    expect(payloads).toHaveLength(1);
    const payload = payloads[0] as { prompt?: string; provider?: string; model?: string };
    expect(payload.provider).toBe('ollama');
    expect(payload.model).toBe('qwen2.5-coder');
    expect(payload.prompt).toContain('Review attached file');
    expect(payload.prompt).toContain('Attached files:');
    expect(payload.prompt).toContain('agent-attachment.txt');
    expect(payload.prompt).toContain('attached context');
    expect(payload.prompt).not.toContain(attachmentPath);
    await expect(d.getByText('agent-attachment.txt')).toBeVisible();
    await expect(d.getByLabel('Agent prompt')).toHaveValue('Review attached file');

    await d.getByRole('button', { name: /Remove file agent-attachment\.txt/ }).click();
    await expect(d.getByText('agent-attachment.txt')).toBeHidden();
  } finally {
    await app.close();
    await fs.rm(attachmentDir, { recursive: true, force: true });
  }
});

test('agent: composer accepts dropped text files as attachments', async () => {
  const { app, page } = await launchApp();
  try {
    await seedGraph(page, { tasks: [{ id: 't1', title: 'Drop a file' }] });
    const d = await openTaskDockChat(page, 't1');
    await d.getByLabel('Agent prompt').dispatchEvent('drop', {
      dataTransfer: await page.evaluateHandle(() => {
        const data = new DataTransfer();
        data.items.add(new File(['dropped context'], 'dropped-note.txt', { type: 'text/plain' }));
        return data;
      }),
    });
    await expect(d.getByText('dropped-note.txt')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('agent: file attachments are count-limited and clipped before sending', async () => {
  const attachmentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'marudesk-agent-bounded-'));
  const paths: string[] = [];
  for (let index = 0; index < 10; index += 1) {
    const filePath = path.join(attachmentDir, `bounded-${index}.txt`);
    const body =
      index === 0
        ? `${'x'.repeat(24_000)}sentinel-after-limit`
        : `bounded file ${index}`;
    await fs.writeFile(filePath, body, 'utf8');
    paths.push(filePath);
  }

  const { app, page } = await launchApp();
  try {
    await app.evaluate(({ ipcMain }) => {
      const g = globalThis as typeof globalThis & { __agentSendPayloads?: unknown[] };
      g.__agentSendPayloads = [];
      ipcMain.removeHandler('agent:send');
      ipcMain.handle('agent:send', (_event, payload) => {
        g.__agentSendPayloads?.push(payload);
        return { ok: false, reason: 'stubbed send failure' };
      });
    });
    await page.evaluate(() => {
      localStorage.setItem('marudesk.providers.selectedModelKey', 'ollama:qwen2.5-coder');
    });
    await seedGraph(page, { tasks: [{ id: 't1', title: 'Bounded attachments' }] });
    const d = await openTaskDockChat(page, 't1');

    await d.locator('input[aria-label="Attach files"]').setInputFiles(paths);
    await expect(d.getByText('bounded-0.txt')).toBeVisible();
    await d.getByLabel('Agent prompt').fill('Review bounded attachments');
    await d.getByRole('button', { name: 'Send' }).click();

    const payloads = await app.evaluate(() => {
      const g = globalThis as typeof globalThis & { __agentSendPayloads?: unknown[] };
      return g.__agentSendPayloads ?? [];
    });
    expect(payloads).toHaveLength(1);
    const payload = payloads[0] as { prompt?: string };
    expect(payload.prompt).toContain('bounded-0.txt');
    expect(payload.prompt).toContain('bounded-7.txt');
    expect(payload.prompt).not.toContain('bounded-8.txt');
    expect(payload.prompt).not.toContain('bounded-9.txt');
    expect(payload.prompt).not.toContain('sentinel-after-limit');
    expect(payload.prompt).toContain('clipped');
  } finally {
    await app.close();
    await fs.rm(attachmentDir, { recursive: true, force: true });
  }
});

function longAssistantText(anchor: string): string {
  return Array.from(
    { length: 120 },
    (_, index) => `${anchor} line ${String(index + 1).padStart(3, '0')}`,
  ).join('\n');
}

function chatStateWithAssistantText(text: string): AgentChatState {
  return {
    turnId: 'turn-scroll-regression',
    status: 'thinking',
    messages: [
      {
        id: 'message-user-scroll-regression',
        role: 'user',
        parts: [{ type: 'text', text: 'Please write a long answer.' }],
        timestamp: 1,
      },
      {
        id: 'message-assistant-scroll-regression',
        role: 'assistant',
        parts: [{ type: 'text', text }],
        timestamp: 2,
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

type ScrollMetrics = {
  readonly scrollTop: number;
  readonly distanceFromBottom: number;
};

async function readScrollMetrics(
  transcript: ReturnType<Page['locator']>,
): Promise<ScrollMetrics> {
  return transcript.evaluate((element) => {
    if (!(element instanceof HTMLElement)) throw new Error('Expected chat transcript element');
    return {
      scrollTop: element.scrollTop,
      distanceFromBottom: element.scrollHeight - element.scrollTop - element.clientHeight,
    };
  });
}

async function nextPaint(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}
