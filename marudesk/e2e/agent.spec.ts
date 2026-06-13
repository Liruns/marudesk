import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './helpers/app';
import type { AgentChatState } from '../shared/agent';
import type { SessionSummary } from '../shared/context';

/**
 * Agentic AI Chat (docs/agentic-chat-design.md). These never call a real LLM —
 * they verify the panel mounts, seeded renderer projections, snapshot IPC
 * round-trips, and the pre-turn validation guards reject cleanly. The full tool
 * loop is driven by the model, so it is exercised by hand / unit-covered, not in
 * CI.
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

test('agent: file changes render after the turn that produced them', async () => {
  const { app, page } = await launchApp();
  try {
    await page.getByRole('button', { name: 'Show context panel' }).click();
    await expect(page.getByLabel('Agent prompt')).toBeVisible();
    await page.evaluate(() => window.marudesk.invoke('agent:snapshot'));

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

    await app.evaluate(({ BrowserWindow }, payload: AgentChatState) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error('missing main window');
      win.webContents.send('agent:event', payload);
    }, state);

    await expect(page.getByText('first_turn_change.txt')).toBeVisible();
    await expect(page.getByText('second_turn_change.txt')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Keep' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Revert' }).first()).toBeVisible();

    const body = await page.locator('body').innerText();
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

test('agent: Home launcher opens the full-surface AI Chat tab (v3 §5-B)', async () => {
  const { app, page } = await launchApp();
  try {
    // The New Tab launcher has an "AI Chat" card that converts the tab in place
    // into the full-surface `agent` tab kind.
    await page.getByRole('button', { name: /^AI Chat(?! \(CLI\))/ }).click();
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
    await page.getByRole('button', { name: /^AI Chat(?! \(CLI\))/ }).click();
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

test('agent: workspace AI Chat tabs keep scoped chat and history', async ({}, testInfo) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'marudesk-agent-workspaces-'));
  const { app, page } = await launchApp();
  try {
    const roots = {
      alpha: await mkWorkspaceRoot(base, 'alpha'),
      beta: await mkWorkspaceRoot(base, 'beta'),
    };
    const workspaces = await page.evaluate(async ({ alpha, beta }) => {
      const a = await window.marudesk.invoke('workspaces:create', {
        name: 'Project Alpha',
        roots: [{ name: 'FE', path: alpha }],
      });
      const b = await window.marudesk.invoke('workspaces:create', {
        name: 'Project Beta',
        roots: [{ name: 'FE', path: beta }],
      });
      const alphaTabId = await window.marudesk.invoke('browser:tabs-new', {
        kind: 'agent',
        workspaceId: a.id,
      });
      await window.marudesk.invoke('browser:tabs-new', {
        kind: 'agent',
        workspaceId: b.id,
      });
      await window.marudesk.invoke('browser:tabs-activate', alphaTabId);
      await window.marudesk.invoke('workspaces:set-active', { workspaceId: a.id });
      return { alphaId: a.id as string, betaId: b.id as string };
    }, roots);

    await installWorkspaceSessionStubs(app, workspaces);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('navigation', { name: 'Workspace rail' })).toBeVisible();

    await page.getByRole('button', { name: 'Split workspace right' }).first().click();
    await page.getByRole('button', { name: 'Workspace Project Beta' }).click();

    const alphaPane = page.getByRole('region', { name: 'Project Alpha' });
    const betaPane = page.getByRole('region', { name: 'Project Beta' });
    await expect(alphaPane).toBeVisible();
    await expect(betaPane).toBeVisible();

    await emitAgentWorkspaceState(
      app,
      workspaces.alphaId,
      chatStateWithAssistantText('alpha-only e2e answer'),
    );
    await expect(alphaPane.getByText('alpha-only e2e answer')).toBeVisible();
    await expect(betaPane.getByText('alpha-only e2e answer')).toHaveCount(0);

    await expect(alphaPane.getByText('Alpha saved session')).toBeVisible();
    await expect(alphaPane.getByText('Beta saved session')).toHaveCount(0);
    await expect(alphaPane.getByText('Legacy unscoped session')).toHaveCount(0);
    await expect(betaPane.getByText('Beta saved session')).toBeVisible();
    await expect(betaPane.getByText('Alpha saved session')).toHaveCount(0);
    await expect(betaPane.getByText('Legacy unscoped session')).toHaveCount(0);

    await alphaPane.getByLabel('Search chats and messages').fill('alpha');
    await expect(alphaPane.getByText('Alpha search hit')).toBeVisible();
    await expect(alphaPane.getByText('Beta search hit')).toHaveCount(0);
    await betaPane.getByLabel('Search chats and messages').fill('beta');
    await expect(betaPane.getByText('Beta search hit')).toBeVisible();
    await expect(betaPane.getByText('Alpha search hit')).toHaveCount(0);

    const unscopedSessions = await page.evaluate(async () => ({
      list: await window.marudesk.invoke('agent:list-sessions', {}),
      search: await window.marudesk.invoke('agent:search-sessions', { query: 'legacy' }),
    }));
    expect(unscopedSessions.list.map((session) => session.title)).toEqual([
      'Legacy unscoped session',
    ]);
    expect(unscopedSessions.search.map((session) => session.title)).toEqual([
      'Legacy search hit',
    ]);

    const requests = await app.evaluate(() => {
      const g = globalThis as typeof globalThis & {
        __workspaceSessionRequests?: readonly {
          channel: string;
          workspaceId?: string;
          query?: string;
        }[];
      };
      return g.__workspaceSessionRequests ?? [];
    });
    expect(requests).toEqual(
      expect.arrayContaining([
        { channel: 'list', workspaceId: workspaces.alphaId },
        { channel: 'list', workspaceId: workspaces.betaId },
        { channel: 'search', workspaceId: workspaces.alphaId, query: 'alpha' },
        { channel: 'search', workspaceId: workspaces.betaId, query: 'beta' },
        { channel: 'list', workspaceId: undefined },
        { channel: 'search', workspaceId: undefined, query: 'legacy' },
      ]),
    );

    await page.screenshot({
      path: testInfo.outputPath('workspace-ai-chat-scoped.png'),
      fullPage: true,
    });
  } finally {
    await app.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('agent: streaming transcript does not re-pin after a small upward scroll', async () => {
  const { app, page } = await launchApp();
  try {
    await page.getByRole('button', { name: /^AI Chat(?! \(CLI\))/ }).click();

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

test('agent: composer attaches a selected file, sends bounded content, and restores on failure', async ({ browserName }) => {
  void browserName;
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
    await page.reload();
    await page.waitForLoadState('domcontentloaded');

    await page.getByRole('button', { name: /^AI Chat(?! \(CLI\))/ }).click();
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
    await fs.rm(attachmentDir, { recursive: true, force: true });
  }
});

test('agent: composer accepts dropped text files as attachments', async () => {
  const { app, page } = await launchApp();
  try {
    await page.getByRole('button', { name: /^AI Chat(?! \(CLI\))/ }).click();
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

test('agent: file attachments are count-limited and clipped before sending', async ({ browserName }) => {
  void browserName;
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
    await page.reload();
    await page.waitForLoadState('domcontentloaded');

    await page.getByRole('button', { name: /^AI Chat(?! \(CLI\))/ }).click();
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

async function mkWorkspaceRoot(base: string, name: string): Promise<string> {
  const dir = path.join(base, name);
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'App.tsx'), `export const n = "${name}";\n`, 'utf8');
  return dir;
}

async function emitAgentWorkspaceState(
  app: ElectronApplication,
  workspaceId: string,
  state: AgentChatState,
): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, payload) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error('Main window not found');
      win.webContents.send('agent:workspace-event', payload);
    },
    { workspaceId, state },
  );
}

async function installWorkspaceSessionStubs(
  app: ElectronApplication,
  workspaces: { readonly alphaId: string; readonly betaId: string },
): Promise<void> {
  await app.evaluate(({ ipcMain }, ids) => {
    type SessionPayload = { readonly workspaceId?: string; readonly query?: string } | undefined;
    const now = Date.now();
    const sessions: readonly SessionSummary[] = [
      {
        id: 'session-alpha',
        workspaceId: ids.alphaId,
        title: 'Alpha saved session',
        createdAt: now - 3_000,
        updatedAt: now - 3_000,
        provider: 'ollama',
        model: 'qwen-test',
        messageCount: 1,
      },
      {
        id: 'session-beta',
        workspaceId: ids.betaId,
        title: 'Beta saved session',
        createdAt: now - 2_000,
        updatedAt: now - 2_000,
        provider: 'ollama',
        model: 'qwen-test',
        messageCount: 1,
      },
      {
        id: 'session-legacy',
        title: 'Legacy unscoped session',
        createdAt: now - 1_000,
        updatedAt: now - 1_000,
        provider: 'ollama',
        model: 'qwen-test',
        messageCount: 1,
      },
    ];
    const requests: { channel: string; workspaceId?: string; query?: string }[] = [];
    const g = globalThis as typeof globalThis & {
      __workspaceSessionRequests?: typeof requests;
    };
    g.__workspaceSessionRequests = requests;
    const workspaceIdOf = (payload: SessionPayload): string | undefined =>
      payload && typeof payload.workspaceId === 'string' ? payload.workspaceId : undefined;
    const queryOf = (payload: SessionPayload): string | undefined =>
      payload && typeof payload.query === 'string' ? payload.query : undefined;
    const scoped = (workspaceId: string | undefined): readonly SessionSummary[] =>
      workspaceId
        ? sessions.filter((session) => session.workspaceId === workspaceId)
        : sessions.filter((session) => !session.workspaceId);

    ipcMain.removeHandler('agent:list-sessions');
    ipcMain.handle('agent:list-sessions', (_event, payload: SessionPayload) => {
      const workspaceId = workspaceIdOf(payload);
      requests.push({ channel: 'list', workspaceId });
      return scoped(workspaceId);
    });
    ipcMain.removeHandler('agent:search-sessions');
    ipcMain.handle('agent:search-sessions', (_event, payload: SessionPayload) => {
      const workspaceId = workspaceIdOf(payload);
      const query = queryOf(payload);
      requests.push({ channel: 'search', workspaceId, query });
      return scoped(workspaceId).map((session) => ({
        ...session,
        title:
          session.workspaceId === ids.alphaId
            ? 'Alpha search hit'
            : session.workspaceId === ids.betaId
              ? 'Beta search hit'
              : 'Legacy search hit',
        snippet: query ? `Matched ${query}` : undefined,
      }));
    });
  }, workspaces);
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
