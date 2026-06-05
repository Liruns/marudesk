import { promises as fs } from 'node:fs';
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './helpers/app';
import type { AgentChatState } from '../shared/agent';

/**
 * Agentic AI Chat (docs/agentic-chat-design.md). These never call a real LLM —
 * they verify the panel mounts, the snapshot IPC round-trips, and the pre-turn
 * validation guards reject cleanly (no key / no workspace). The full tool loop is
 * driven by the model, so it's exercised by hand / unit-covered, not in CI.
 */

test('agent: chat panel mounts as the default Context tab', async () => {
  const { app, page } = await launchApp();
  try {
    await page.getByRole('button', { name: 'Show context panel' }).click();
    // Agent is the primary tab now.
    await expect(page.getByRole('tab', { name: 'Agent' })).toBeVisible();
    await expect(page.getByText('Agentic AI Chat')).toBeVisible();
    await expect(page.getByLabel('Agent prompt')).toBeVisible();
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

test('agent: Home launcher opens the full-surface AI Chat tab (v3 §5-B)', async () => {
  const { app, page } = await launchApp();
  try {
    // The New Tab launcher has an "AI Chat" card that converts the tab in place
    // into the full-surface `agent` tab kind.
    await page.getByRole('button', { name: /AI Chat/ }).click();
    // The tab strip shows the AI Chat tab, and the full surface renders the same
    // chat (the prompt composer) — proving the new kind registered end to end.
    // Scope to <main> (the stage): the always-mounted ContextDrawer companion
    // (<aside aria-label="Context cart">) also has an "Agent prompt", and both
    // project the same conversation — so an unscoped match resolves to two.
    await expect(page.getByRole('tab', { name: 'AI Chat' })).toBeVisible();
    await expect(page.getByRole('main').getByLabel('Agent prompt')).toBeVisible();
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

test('agent: full surface shows the session history rail (§5-C)', async () => {
  const { app, page } = await launchApp();
  try {
    await page.getByRole('button', { name: /AI Chat/ }).click();
    await expect(page.getByRole('tab', { name: 'AI Chat' })).toBeVisible();
    // The left rail renders its header + the New chat affordance.
    await expect(page.getByRole('main').getByText('History')).toBeVisible();
    await expect(
      page.getByRole('main').getByRole('button', { name: 'New chat' }),
    ).toBeVisible();
  } finally {
    await app.close();
  }
});

test('agent: drawer history overlay opens from the header (§5-C)', async () => {
  const { app, page } = await launchApp();
  try {
    await page.getByRole('button', { name: 'Show context panel' }).click();
    await expect(page.getByRole('tab', { name: 'Agent' })).toBeVisible();
    // The History button in the drawer header reveals the sessions overlay.
    await page.getByRole('button', { name: 'History' }).click();
    await expect(page.getByRole('button', { name: 'New chat' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('agent: streaming transcript does not re-pin after a small upward scroll', async () => {
  const { app, page } = await launchApp();
  try {
    await page.getByRole('button', { name: /AI Chat/ }).click();

    const baseText = longAssistantText('scroll-regression-start');
    await emitAgentState(app, chatStateWithAssistantText(baseText));
    const transcript = page
      .locator('main .overflow-y-auto')
      .filter({ hasText: 'scroll-regression-start' })
      .first();
    await expect(transcript).toBeVisible();
    await expect
      .poll(async () => (await readScrollMetrics(page)).distanceFromBottom)
      .toBeLessThanOrEqual(1);

    const bottomTop = (await readScrollMetrics(page)).scrollTop;
    const box = await transcript.boundingBox();
    if (!box) throw new Error('Chat transcript box not found');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -24);
    await expect.poll(async () => (await readScrollMetrics(page)).scrollTop).toBeLessThan(bottomTop);

    await emitAgentState(
      app,
      chatStateWithAssistantText(`${baseText}\n\nstreaming update after small scroll`),
    );
    await expect(page.getByRole('main').getByText('streaming update after small scroll')).toBeAttached();
    await nextPaint(page);

    const afterStreamTop = (await readScrollMetrics(page)).scrollTop;
    expect(afterStreamTop).toBeLessThan(bottomTop - 5);
  } finally {
    await app.close();
  }
});

test('agent: composer attaches a selected file, sends bounded content, and restores on failure', async ({ browserName }, testInfo) => {
  void browserName;
  const attachmentPath = testInfo.outputPath('agent-attachment.txt');
  await fs.writeFile(attachmentPath, 'attached context');
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
    await page.reload();
    await page.waitForLoadState('domcontentloaded');

    await page.getByRole('button', { name: /AI Chat/ }).click();
    const main = page.getByRole('main');
    await main.locator('input[aria-label="Attach files"]').setInputFiles(attachmentPath);
    await expect(main.getByText('agent-attachment.txt')).toBeVisible();
    await main.getByLabel('Agent prompt').fill('Review attached file');
    await main.getByRole('button', { name: 'Send' }).click();

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
    await expect(main.getByText('agent-attachment.txt')).toBeVisible();
    await expect(main.getByLabel('Agent prompt')).toHaveValue('Review attached file');

    await main.getByRole('button', { name: /Remove file agent-attachment\.txt/ }).click();
    await expect(main.getByText('agent-attachment.txt')).toBeHidden();
  } finally {
    await app.close();
  }
});

test('agent: composer accepts dropped text files as attachments', async () => {
  const { app, page } = await launchApp();
  try {
    await page.getByRole('button', { name: /AI Chat/ }).click();
    const main = page.getByRole('main');
    await main.getByLabel('Agent prompt').dispatchEvent('drop', {
      dataTransfer: await page.evaluateHandle(() => {
        const data = new DataTransfer();
        data.items.add(new File(['dropped context'], 'dropped-note.txt', { type: 'text/plain' }));
        return data;
      }),
    });
    await expect(main.getByText('dropped-note.txt')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('agent: file attachments are count-limited and clipped before sending', async ({ browserName }, testInfo) => {
  void browserName;
  const paths: string[] = [];
  for (let index = 0; index < 10; index += 1) {
    const filePath = testInfo.outputPath(`bounded-${index}.txt`);
    const body =
      index === 0
        ? `${'x'.repeat(24_000)}sentinel-after-limit`
        : `bounded file ${index}`;
    await fs.writeFile(filePath, body);
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
    await page.reload();
    await page.waitForLoadState('domcontentloaded');

    await page.getByRole('button', { name: /AI Chat/ }).click();
    const main = page.getByRole('main');
    await main.locator('input[aria-label="Attach files"]').setInputFiles(paths);
    await expect(main.getByText('bounded-0.txt')).toBeVisible();
    await main.getByLabel('Agent prompt').fill('Review bounded attachments');
    await main.getByRole('button', { name: 'Send' }).click();

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

type ScrollMetrics = {
  readonly scrollTop: number;
  readonly distanceFromBottom: number;
};

async function readScrollMetrics(page: Page): Promise<ScrollMetrics> {
  return page.locator('main .overflow-y-auto').filter({ hasText: 'scroll-regression-start' }).first().evaluate((element) => {
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
