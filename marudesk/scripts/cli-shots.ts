import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { spawn as ptySpawn } from 'node-pty';
import { chromium } from '@playwright/test';
import type { AgentChatState, AgentSendResult } from '../shared/agent.ts';
import { emptyAgentChatState } from '../shared/agent.ts';
import { handleRequest, type RouterDeps } from '../electron/server/router.ts';

/**
 * Not a test — a screenshot harness for the chat CLI's TUI. Boots the pure
 * router on loopback with a scripted agent, runs the REAL CLI inside a PTY,
 * drives a session (banner → slash menu → streamed turn with tools/plan →
 * approval panel), and renders the captured ANSI byte stream through xterm.js
 * (the same emulator as the app's terminal tab, same theme) into PNGs.
 *
 * Run: node --experimental-strip-types --import ./electron/server/harness-register.mjs scripts/cli-shots.ts
 * Output: marudesk/.screens/cli/*.png
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(here, '..');
const OUT = path.join(PKG_ROOT, '.screens', 'cli');
const TOKEN = 'cli-shots-token';
const COLS = 100;
const ROWS = 32;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/* ── scripted agent ───────────────────────────────────────────────────────── */

const ANSWER = [
  'The 401 comes from a **stale `Authorization` header** — `useSession` memoises the token at mount and never refreshes it after the silent re-auth.',
  '',
  'Fix — read the token at request time:',
  '',
  '```ts',
  'const token = await auth.currentToken();',
  'return fetch(url, { headers: { Authorization: `Bearer ${token}` } });',
  '```',
  '',
  'After the change the retried `GET /api/projects` returns `200`.',
].join('\n');

type Frame = { at: number; state: AgentChatState };

function buildTurnFrames(): Frame[] {
  const base = (): AgentChatState => ({
    ...emptyAgentChatState(),
    turnId: 'turn-1',
    usage: { inputTokens: 18_420, outputTokens: 2_310, contextTokens: 21_900 },
  });
  const msg = (parts: AgentChatState['messages'][number]['parts']): AgentChatState['messages'] => [
    { id: 'u1', turnId: 'turn-1', role: 'user', parts: [{ type: 'text', text: 'why do API calls 401 right after login?' }], timestamp: 1 },
    { id: 'a1', turnId: 'turn-1', role: 'assistant', parts, timestamp: 2 },
  ];
  const grepOk = {
    type: 'tool' as const,
    call: { id: 't1', name: 'grep', input: {}, state: 'ok' as const, summary: '"Authorization" — 4 matches in 3 files' },
  };
  const readRunning = {
    type: 'tool' as const,
    call: { id: 't2', name: 'read_file', input: {}, state: 'running' as const, summary: 'src/hooks/useSession.ts' },
  };
  const readOk = { ...readRunning, call: { ...readRunning.call, state: 'ok' as const } };
  const reasoning = {
    type: 'reasoning' as const,
    text: 'Only the first calls after login fail, so the token is probably captured once and cached. Check the session hook, then the fetch wrapper.\n',
  };
  const plan: AgentChatState['plan'] = {
    updatedAt: 3,
    steps: [
      { id: 's1', title: 'Trace the stale Authorization header', status: 'done' },
      { id: 's2', title: 'Patch the fetch wrapper', status: 'in_progress' },
      { id: 's3', title: 'Reload and verify the requests succeed', status: 'pending' },
    ],
  };
  return [
    { at: 80, state: { ...base(), status: 'thinking', messages: msg([reasoning]) } },
    { at: 500, state: { ...base(), status: 'working', messages: msg([reasoning, grepOk, readRunning]) } },
    { at: 1000, state: { ...base(), status: 'working', plan, messages: msg([reasoning, grepOk, readRunning]) } },
    { at: 1600, state: { ...base(), status: 'working', plan, messages: msg([reasoning, grepOk, readOk, { type: 'text', text: ANSWER.slice(0, 120) }]) } },
    { at: 2200, state: { ...base(), status: 'working', plan, messages: msg([reasoning, grepOk, readOk, { type: 'text', text: ANSWER }]) } },
    { at: 2600, state: { ...base(), status: 'completed', plan, messages: msg([reasoning, grepOk, readOk, { type: 'text', text: ANSWER }]) } },
  ];
}

function approvalState(): AgentChatState {
  return {
    ...emptyAgentChatState(),
    turnId: 'turn-2',
    status: 'waiting_for_user',
    pendingApproval: {
      turnId: 'turn-2',
      callId: 'c-edit',
      name: 'edit_file',
      detail: 'src/lib/api.ts — resolve the token per request instead of caching it',
      diffs: [
        {
          path: 'src/lib/api.ts',
          before: 'export async function apiFetch(path: string) {\n  const token = session.token;\n  return fetch(url, { headers: { Authorization: `Bearer ${token}` } });\n}',
          after: 'export async function apiFetch(path: string) {\n  const token = await auth.currentToken();\n  return fetch(url, { headers: { Authorization: `Bearer ${token}` } });\n}',
        },
      ],
    },
  };
}

/* ── mock bridge ──────────────────────────────────────────────────────────── */

function makeDeps(): { deps: RouterDeps; emit: (s: AgentChatState) => void } {
  const subs = new Set<(s: AgentChatState) => void>();
  const emit = (state: AgentChatState): void => {
    for (const cb of subs) cb(state);
  };
  let turnCount = 0;
  const deps: RouterDeps = {
    token: TOKEN,
    version: '0.8.0',
    agent: {
      async startTurn(): Promise<AgentSendResult> {
        turnCount += 1;
        if (turnCount === 1) {
          for (const f of buildTurnFrames()) setTimeout(() => emit(f.state), f.at);
          return { ok: true, turnId: 'turn-1' };
        }
        setTimeout(() => emit(approvalState()), 120);
        return { ok: true, turnId: 'turn-2' };
      },
      abortTurn: () => true,
      respond: () => true,
      approveTool: () => true,
      snapshot: () => emptyAgentChatState(),
      reset: () => true,
      editPlanStep: () => true,
      setApprovalMode: () => true,
      setReasoningEffort: () => true,
    },
    subscribe(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    // The CLI auto-adopts the active workspace and asks for a scoped stream;
    // this mock has a single conversation, so scope = the global stream.
    subscribeWorkspace(_workspaceId, cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    extras: {
      models: () =>
        Promise.resolve({
          providers: [
            {
              id: 'anthropic',
              label: 'Anthropic',
              connected: true,
              defaultModelId: 'claude-sonnet-4-6',
              models: [{ id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' }],
            },
          ],
        }),
      sessions: () => Promise.resolve([]),
      resumeSession: () => Promise.resolve(true),
      workspaces: () =>
        Promise.resolve({
          workspaces: [{ id: 'ws-1', name: 'acme-web' }],
          activeWorkspaceId: 'ws-1',
        }),
      readSession: () => Promise.resolve(null),
      catalog: () => Promise.resolve({ agents: [], skills: [] }),
    },
  };
  return { deps, emit };
}

/* ── capture ──────────────────────────────────────────────────────────────── */

async function capture(): Promise<{ name: string; bytes: Buffer }[]> {
  const { deps } = makeDeps();
  const server = http.createServer((req, res) => void handleRequest(req, res, deps));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  const term = ptySpawn(
    process.execPath,
    [
      '--experimental-strip-types',
      '--import',
      pathToFileURL(path.join(PKG_ROOT, 'electron/server/harness-register.mjs')).href,
      path.join(PKG_ROOT, 'cli/main.ts'),
      '--url', url,
      '--token', TOKEN,
      '--provider', 'anthropic',
      '--model', 'claude-sonnet-4-6',
    ],
    {
      cols: COLS,
      rows: ROWS,
      cwd: PKG_ROOT,
      env: { ...process.env, TERM: 'xterm-256color', NODE_NO_WARNINGS: '1' },
    },
  );

  let bytes = Buffer.alloc(0);
  term.onData((d) => {
    bytes = Buffer.concat([bytes, Buffer.from(d, 'utf8')]);
  });
  const snaps: { name: string; bytes: Buffer }[] = [];
  const snap = (name: string): void => {
    snaps.push({ name, bytes: Buffer.from(bytes) });
    console.log(`[cli-shots] snapshot ${name} (${bytes.length} bytes)`);
  };

  await sleep(1800); // banner + initial paint
  snap('01-banner');

  term.write('/mo');
  await sleep(500);
  snap('02-slash-menu');
  term.write('\x1b'); // esc — clear the draft
  await sleep(300);

  term.write('why do API calls 401 right after login?\r');
  await sleep(1300); // mid-stream: running tool + spinner
  snap('03-streaming');
  await sleep(2400); // settle: plan + markdown answer + done line
  snap('04-conversation');

  term.write('apply the fix\r');
  await sleep(900); // approval panel with the inline diff
  snap('05-approval');
  term.write('y');
  await sleep(400);

  term.write('\x03'); // ctrl+c (arm)
  await sleep(150);
  term.write('\x03'); // ctrl+c (exit)
  await Promise.race([new Promise<void>((r) => term.onExit(() => r())), sleep(2000)]);
  try {
    term.kill();
  } catch {
    // already gone
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return snaps;
}

/* ── render ───────────────────────────────────────────────────────────────── */

async function render(snaps: { name: string; bytes: Buffer }[]): Promise<void> {
  const xtermJs = path.join(PKG_ROOT, 'node_modules/@xterm/xterm/lib/xterm.js');
  const xtermCss = path.join(PKG_ROOT, 'node_modules/@xterm/xterm/css/xterm.css');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 720 } });
  await page.setContent(
    `<!doctype html><html><head><style>${fs.readFileSync(xtermCss, 'utf8')}</style>
     <style>body{margin:0;background:#08090A;padding:16px}</style></head>
     <body><div id="t"></div></body></html>`,
  );
  await page.addScriptTag({ path: xtermJs });
  for (const snap of snaps) {
    const { name } = snap;
    await page.evaluate(
      async ({ b64, cols, rows }) => {
        document.getElementById('t')!.innerHTML = '';
        const w = window as unknown as { Terminal: new (o: object) => { open(el: HTMLElement): void; write(d: Uint8Array, cb: () => void): void } };
        const term = new w.Terminal({
          cols,
          rows,
          fontSize: 14,
          fontFamily: 'monospace',
          theme: {
            background: '#08090A',
            foreground: '#F7F8F8',
            cursor: '#5E6AD2',
            cursorAccent: '#08090A',
            selectionBackground: 'rgba(94, 106, 210, 0.32)',
          },
        });
        term.open(document.getElementById('t')!);
        const raw = atob(b64);
        const data = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) data[i] = raw.charCodeAt(i);
        await new Promise<void>((resolve) => term.write(data, resolve));
      },
      { b64: snap.bytes.toString('base64'), cols: COLS, rows: ROWS },
    );
    await page.waitForTimeout(120);
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    console.log(`[cli-shots] ${name}.png`);
  }
  await browser.close();
}

fs.mkdirSync(OUT, { recursive: true });
const snaps = await capture();
await render(snaps);
console.log('[cli-shots] done');
