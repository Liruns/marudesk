import { test, expect } from '@playwright/test';
import type { AgentChatState } from '../shared/agent';
import { launchApp } from './helpers/app';

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
      pendingQuestions: null,
      usage: { inputTokens: 0, outputTokens: 0, contextTokens: 0 },
      error: null,
      activeSessionId: null,
      endNote: null,
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
