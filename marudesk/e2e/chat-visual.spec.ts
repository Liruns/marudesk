import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launchApp, type LaunchedApp } from './helpers/app';
import {
  dock,
  dockThreadId,
  emitToThread,
  openTaskDockChat,
  seedGraph,
} from './helpers/mission-control';
import { emptyAgentChatState, type AgentChatState } from '../shared/agent';

/**
 * Not a real test — a screenshot harness for the AI Chat surface. Mission Control
 * made the Task graph the only home, so the chat now lives in the per-task
 * Instrument Dock (Phase 2b). This seeds a one-task graph, selects the node to open
 * its dock chat, then pushes synthetic `agent:thread-event` snapshots straight from
 * the main process to the dock chat's bound thread so every chat state (empty, rich
 * transcript, streaming, plan, approval, questions, error) can be eyeballed without
 * a provider key or a live model. Screenshots are scoped to the dock aside.
 *
 * Run: npx playwright test chat-visual   (after npm run build)
 * Output: marudesk/.screens/chat/*.png
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '..', '.screens', 'chat');

test.setTimeout(90_000);

// The shared factory keeps this harness honest as AgentChatState evolves —
// hand-built literals here would silently miss new required fields.
const baseState = (): AgentChatState => emptyAgentChatState();

const ANSWER_MD = [
  'The 401 comes from a stale `Authorization` header: `useSession` memoises the token at mount and never refreshes it after the silent re-auth.',
  '',
  '**Fix** — read the token at request time instead of capture time:',
  '',
  '```ts',
  'export async function apiFetch(path: string, init?: RequestInit) {',
  '  const token = await auth.currentToken(); // not the mounted snapshot',
  '  return fetch(`${API_BASE}${path}`, {',
  '    ...init,',
  '    headers: { ...init?.headers, Authorization: `Bearer ${token}` },',
  '  });',
  '}',
  '```',
  '',
  'I checked the network log — after this change the retried `GET /api/projects` returns `200` with the refreshed token.',
].join('\n');

function richState(): AgentChatState {
  const s = baseState();
  s.status = 'completed';
  s.turnId = 'turn-1';
  s.usage = { inputTokens: 18_420, outputTokens: 2_310, contextTokens: 21_900 };
  s.messages = [
    {
      id: 'm1',
      turnId: 'turn-1',
      role: 'user',
      parts: [
        {
          type: 'text',
          text: 'Login works but every API call right after returns 401. Can you find why and fix it?',
        },
      ],
      timestamp: Date.now() - 60_000,
    },
    {
      id: 'm2',
      turnId: 'turn-1',
      role: 'assistant',
      parts: [
        {
          type: 'reasoning',
          text: 'The 401 happens only on the first calls after login, so the token is probably read once and cached. Check the session hook and the fetch wrapper first, then confirm against the live network log.',
        },
        {
          type: 'tool',
          call: {
            id: 't1',
            name: 'grep',
            input: { pattern: 'Authorization' },
            state: 'ok',
            summary: 'grep "Authorization" — 4 matches in 3 files',
            resultText: 'src/lib/api.ts:12\nsrc/hooks/useSession.ts:33\nsrc/hooks/useSession.ts:51\nsrc/auth/refresh.ts:8',
          },
        },
        {
          type: 'tool',
          call: {
            id: 't2',
            name: 'read_file',
            input: { path: 'src/hooks/useSession.ts' },
            state: 'ok',
            summary: 'read src/hooks/useSession.ts',
            resultText: 'const token = useMemo(() => session.token, []); // ← stale: empty deps',
          },
        },
        {
          type: 'tool',
          call: {
            id: 't3',
            name: 'read_network',
            input: {},
            state: 'ok',
            summary: 'network log — 3 requests after sign-in',
            resultText: 'GET /api/projects → 401 (Authorization: Bearer eyJ…expired)\nPOST /auth/refresh → 200\nGET /api/projects → 401 (same stale header)',
          },
        },
        {
          type: 'tool',
          call: {
            id: 't4',
            name: 'edit_file',
            input: { path: 'src/lib/api.ts' },
            state: 'ok',
            summary: 'edit src/lib/api.ts — resolve token per request',
          },
        },
        { type: 'text', text: ANSWER_MD },
      ],
      timestamp: Date.now() - 12_000,
    },
  ];
  return s;
}

function streamingState(): AgentChatState {
  const s = richState();
  s.status = 'working';
  const last = s.messages[1];
  last.parts = [
    s.messages[1].parts[0],
    s.messages[1].parts[1],
    {
      type: 'tool',
      call: {
        id: 't2',
        name: 'read_file',
        input: { path: 'src/hooks/useSession.ts' },
        state: 'running',
        summary: 'reading src/hooks/useSession.ts',
      },
    },
  ];
  s.plan = {
    updatedAt: Date.now(),
    steps: [
      { id: 's1', title: 'Reproduce the 401 against the live app', status: 'done' },
      { id: 's2', title: 'Trace the stale Authorization header', status: 'in_progress' },
      { id: 's3', title: 'Patch the fetch wrapper', status: 'pending' },
      { id: 's4', title: 'Reload and verify the requests succeed', status: 'pending' },
    ],
  };
  return s;
}

function approvalState(): AgentChatState {
  const s = streamingState();
  s.status = 'waiting_for_user';
  s.pendingApproval = {
    turnId: 'turn-1',
    callId: 't9',
    name: 'edit_file',
    detail: 'src/lib/api.ts — replace the cached token with a per-request read',
    diffs: [
      {
        path: 'src/lib/api.ts',
        before: 'const token = session.token;\nreturn fetch(url, { headers: { Authorization: `Bearer ${token}` } });',
        after: 'const token = await auth.currentToken();\nreturn fetch(url, { headers: { Authorization: `Bearer ${token}` } });',
      },
    ],
  };
  return s;
}

function questionsState(): AgentChatState {
  const s = streamingState();
  s.status = 'waiting_for_user';
  s.pendingQuestions = {
    turnId: 'turn-1',
    callId: 'q1',
    questions: [
      {
        id: 'q-scope',
        question: 'Refresh the token silently, or redirect to the sign-in page when it expires?',
        options: ['Silent refresh', 'Redirect to sign-in', 'Ask per session'],
      },
    ],
  };
  return s;
}

function errorState(): AgentChatState {
  const s = richState();
  s.status = 'failed';
  s.error = 'Provider rejected the request: model overloaded (529). The turn was not charged.';
  return s;
}

async function shot(launched: LaunchedApp, name: string): Promise<void> {
  try {
    // Scope to the dock aside — the chat is no longer a full-window surface.
    await dock(launched.page).screenshot({ path: path.join(OUT, `${name}.png`) });
    console.log(`[chat-visual] ${name}.png`);
  } catch (err) {
    console.log(`[chat-visual] FAILED ${name}: ${(err as Error).message}`);
  }
}

test('capture AI chat states', async () => {
  fs.mkdirSync(OUT, { recursive: true });
  let launched: LaunchedApp | null = null;
  try {
    launched = await launchApp();
    const { app, page } = launched;

    // The chat lives in the per-task Instrument Dock: seed a one-task graph, select
    // the node to open the dock chat, and resolve the thread it's bound to so the
    // synthetic snapshots land on the right conversation.
    await seedGraph(page, { tasks: [{ id: 't1', title: 'Trace the post-login 401' }] });
    const d = await openTaskDockChat(page, 't1');
    const threadId = await dockThreadId(page);

    await shot(launched, '01-empty');

    await emitToThread(app, threadId, richState());
    await expect(d.getByText('useSession', { exact: true })).toBeVisible();
    await shot(launched, '02-transcript');

    // Scroll the transcript to the bottom so the answer + receipt are visible.
    const transcript = d.locator('.overflow-y-auto').first();
    await transcript.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(400);
    await shot(launched, '03-transcript-bottom');

    await emitToThread(app, threadId, streamingState());
    await shot(launched, '04-streaming-plan');

    await emitToThread(app, threadId, approvalState());
    await shot(launched, '05-approval');

    await emitToThread(app, threadId, questionsState());
    await shot(launched, '06-questions');

    await emitToThread(app, threadId, errorState());
    await shot(launched, '07-error');

    // Slash menu over the composer.
    await emitToThread(app, threadId, baseState());
    await d.getByLabel('Agent prompt').click();
    await page.keyboard.type('/');
    await page.waitForTimeout(400);
    await shot(launched, '08-slash-menu');
    await page.keyboard.press('Escape');
  } finally {
    if (launched) await launched.app.close();
  }
});
