import { spawn } from 'node:child_process';
import http from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AgentChatState, AgentSendInput, AgentSendResult } from '../../shared/agent';
import { emptyAgentChatState } from '../../shared/agent';
import { check, passedCount } from '../harness-kit';
import { stringWidth, truncate, wrapText } from '../../cli/ansi.ts';
import {
  backspace,
  deleteWordLeft,
  EMPTY_COMPOSER,
  emptyHistory,
  historyNext,
  historyPrev,
  insert,
  moveLeft,
  pushHistory,
} from '../../cli/composer.ts';
import { KeyDecoder } from '../../cli/keys.ts';
import { createMarkdownRenderer } from '../../cli/markdown.ts';
import { cliSlashCommands, resolveCliSlash } from '../../cli/slash.ts';
import { createTranscript } from '../../cli/transcript.ts';
import { startCompanionServer } from './companion-core.ts';
import { handleRequest, type RouterDeps } from './router.ts';

/**
 * Headless harness for the chat CLI v2 (docs/chat-cli-tui-design.md §8). Three
 * layers, no Electron:
 *
 *  1. END-TO-END — boots the PURE router on loopback with a mocked agent and
 *     runs the real CLI (cli/main.ts via --experimental-strip-types) as a child
 *     in one-shot line mode: auth, send, streamed render, exit codes.
 *  2. COMPANION — exercises companion-core.ts: loopback-only ephemeral bind,
 *     handshake file write/remove, the catalog routes, and the L-1 contrast
 *     (no guard here ⇒ gated approve allowed; a guarded router refuses it).
 *  3. PURE TUI MODULES — composer editing, key decoding (split UTF-8 +
 *     bracketed paste), markdown wrap, snapshot→transcript diffing, slash
 *     registry.
 */

const TOKEN = 'cli-harness-token';
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function assistantState(text: string, status: AgentChatState['status']): AgentChatState {
  return {
    ...emptyAgentChatState(),
    status,
    turnId: 'turn-cli',
    messages: [
      {
        id: 'm-cli-1',
        turnId: 'turn-cli',
        role: 'assistant',
        parts: [{ type: 'text', text }],
        timestamp: 1,
      },
    ],
    usage: { inputTokens: 11, outputTokens: 7, contextTokens: 11 },
  };
}

type MockAgent = { deps: RouterDeps; sends: AgentSendInput[] };

function mockDeps(extra?: Partial<RouterDeps>): MockAgent {
  const subs = new Set<(s: AgentChatState) => void>();
  const sends: AgentSendInput[] = [];
  const emit = (state: AgentChatState): void => {
    for (const cb of subs) cb(state);
  };
  const deps: RouterDeps = {
    token: TOKEN,
    version: '0.0.0-cli-harness',
    agent: {
      async startTurn(input: AgentSendInput): Promise<AgentSendResult> {
        sends.push(input);
        // Simulate the loop: ack now, stream the turn shortly after.
        setTimeout(() => emit(assistantState('', 'thinking')), 20);
        setTimeout(() => emit(assistantState('Hello from ', 'working')), 60);
        setTimeout(() => emit(assistantState('Hello from the mock loop.', 'working')), 100);
        setTimeout(() => emit(assistantState('Hello from the mock loop.', 'completed')), 140);
        return { ok: true, turnId: 'turn-cli' };
      },
      abortTurn: () => true,
      respond: () => true,
      approveTool: () => true,
      snapshot: () => ({
        ...emptyAgentChatState(),
        pendingApproval: {
          turnId: 'turn-cli',
          callId: 'call-gated',
          name: 'eval_js',
          detail: '1 + 1',
        },
      }),
      reset: () => true,
      editPlanStep: () => true,
      setApprovalMode: () => true,
      setReasoningEffort: () => true,
    },
    subscribe(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    ...extra,
  };
  return { deps, sends };
}

/** Args the EXTRAS mock saw — so the route → backend threading is assertable. */
const extrasCalls = {
  sessionFilters: [] as (string | null | undefined)[],
  resumes: [] as { id: string; workspaceId: string | undefined }[],
};

const EXTRAS: NonNullable<RouterDeps['extras']> = {
  models: () =>
    Promise.resolve({
      providers: [
        {
          id: 'anthropic',
          label: 'Anthropic',
          connected: true,
          defaultModelId: 'mock-sonnet',
          models: [{ id: 'mock-sonnet', label: 'Mock Sonnet' }],
        },
        { id: 'openai', label: 'OpenAI', connected: false, models: [] },
      ],
    }),
  sessions: (workspaceId) => {
    extrasCalls.sessionFilters.push(workspaceId);
    return Promise.resolve([
      {
        id: 'sess-1',
        title: 'mock session',
        createdAt: 1,
        updatedAt: 2,
        provider: 'anthropic',
        model: 'mock-sonnet',
        messageCount: 4,
      },
    ]);
  },
  resumeSession: (id, workspaceId) => {
    extrasCalls.resumes.push({ id, workspaceId });
    return Promise.resolve(id === 'sess-1');
  },
  workspaces: () =>
    Promise.resolve({
      workspaces: [{ id: 'ws-1', name: 'Mock workspace' }],
      activeWorkspaceId: 'ws-1',
    }),
  readSession: (id) =>
    Promise.resolve(
      id === 'sess-1'
        ? {
            title: 'mock session',
            provider: 'anthropic',
            model: 'mock-sonnet',
            messageCount: 2,
            createdAt: 1,
            updatedAt: 2,
            transcript: 'User: hello\n\nAssistant: hi there',
          }
        : null,
    ),
};

async function fetchJson(
  url: string,
  route: string,
  init?: RequestInit & { token?: string },
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${url}${route}`, {
    ...init,
    headers: {
      authorization: `Bearer ${init?.token ?? TOKEN}`,
      'content-type': 'application/json',
    },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/* ── layer 3: pure TUI modules ────────────────────────────────────────────── */

function checkPureModules(): void {
  // composer: code-point-safe editing over a surrogate-pair emoji + Korean.
  let c = insert(EMPTY_COMPOSER, 'an녕😀');
  c = backspace(c); // removes the whole emoji, not half a surrogate
  check('composer: backspace removes a full code point', c.text === 'an녕');
  c = moveLeft(c);
  c = insert(c, 'X');
  check('composer: insert at a moved cursor', c.text === 'anX녕' && c.cursor === 3);
  c = deleteWordLeft({ text: 'one two three', cursor: 13 });
  check('composer: ctrl+w deletes the word left', c.text === 'one two ');

  let h = emptyHistory();
  h = pushHistory(h, 'first');
  h = pushHistory(h, 'second');
  const prev = historyPrev(h, 'draft!');
  check('history: ↑ recalls the last entry', prev?.text === 'second');
  const prev2 = prev ? historyPrev(prev.history, prev.text) : null;
  check('history: ↑↑ recalls the older entry', prev2?.text === 'first');
  const fwd = prev2 ? historyNext(prev2.history) : null;
  const back = fwd ? historyNext(fwd.history) : null;
  check('history: ↓ to the end restores the draft', back?.text === 'draft!');

  // keys: a CJK char split across chunks must not become U+FFFD.
  const dec = new KeyDecoder();
  const bytes = Buffer.from('한', 'utf8');
  const first = dec.push(bytes.subarray(0, 1));
  const rest = dec.push(bytes.subarray(1));
  check(
    'keys: split UTF-8 reassembles',
    first.length === 0 && rest.length === 1 && rest[0].type === 'char' && rest[0].ch === '한',
  );
  const paste = new KeyDecoder();
  const events = paste.push(Buffer.from('\x1b[200~line1\r\nline2\x1b[201~', 'utf8'));
  check(
    'keys: bracketed paste is one event with normalized newlines',
    events.length === 1 && events[0].type === 'paste' && events[0].text === 'line1\nline2',
  );
  const arrows = new KeyDecoder();
  const seq = arrows.push(Buffer.from('\x1b[A\x1b[D\x1b[3~\x01', 'utf8'));
  check(
    'keys: CSI arrows, delete and ctrl decode',
    seq.map((e) => e.type).join(',') === 'up,left,delete,ctrl',
  );
  const lone = new KeyDecoder();
  check(
    'keys: a lone ESC is held then flushed as esc',
    lone.push(Buffer.from('\x1b', 'utf8')).length === 0 &&
      lone.flushEscape()[0]?.type === 'esc',
  );

  // ansi: wide-char width + ANSI-aware truncate.
  check('ansi: Hangul counts 2 cells', stringWidth('한글') === 4);
  check('ansi: wrap breaks CJK mid-word', wrapText('가나다라', 4).length === 2);
  const cut = truncate('\x1b[1m가나다라\x1b[22m', 5);
  check('ansi: truncate keeps escapes and appends …', cut.includes('\x1b[1m') && cut.endsWith('…'));

  // markdown: fences toggle, inline styling on complete pairs only.
  const md = createMarkdownRenderer();
  const fence = md.renderLine('```ts', 40);
  const code = md.renderLine('const x = 1;', 40);
  md.renderLine('```', 40);
  const bold = md.renderLine('**bold** and *it* and `code`', 60).join('');
  check('markdown: fence lines render dim', fence[0].includes('```'));
  check('markdown: code lines indent without inline styling', code[0].includes('const x = 1;'));
  check(
    'markdown: inline pairs style',
    bold.includes('\x1b[1mbold\x1b[22m') && bold.includes('\x1b[36mcode\x1b[39m'),
  );

  // transcript: user echo, streamed commit boundary, tool line, settle line.
  const t = createTranscript({ cols: () => 60 });
  const base = emptyAgentChatState();
  const u1 = t.apply({
    ...base,
    status: 'thinking',
    turnId: 't1',
    messages: [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'do the thing' }], timestamp: 1 },
    ],
  });
  check('transcript: user message echoes once', u1.commit.join('\n').includes('do the thing'));
  const partial = t.apply({
    ...base,
    status: 'working',
    turnId: 't1',
    messages: [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'do the thing' }], timestamp: 1 },
      {
        id: 'a1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'line one\npart' }],
        timestamp: 2,
      },
    ],
  });
  check(
    'transcript: only completed lines commit while streaming',
    partial.commit.join('\n').includes('line one') &&
      !partial.commit.join('\n').includes('part'),
  );
  check('transcript: the partial tail stays live', t.live('⠋').lines.join('\n').includes('part'));
  const settled = t.apply({
    ...base,
    status: 'completed',
    messages: [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'do the thing' }], timestamp: 1 },
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'line one\npart done\n' },
          {
            type: 'tool',
            call: { id: 'c1', name: 'read_file', input: {}, state: 'ok', summary: 'src/x.ts' },
          },
        ],
        timestamp: 2,
      },
    ],
    usage: { inputTokens: 10, outputTokens: 5, contextTokens: 10 },
  });
  const settledText = settled.commit.join('\n');
  check('transcript: settle flushes the tail + tool line', settledText.includes('part done') && settledText.includes('read_file'));
  check('transcript: settle prints the done summary', settled.settled && settledText.includes('done'));
  const swapped = t.apply({ ...base, status: 'idle', messages: [] });
  check(
    'transcript: a history swap prints the reset divider',
    swapped.commit.join('\n').includes('new conversation'),
  );

  // slash: shared prompt commands come through verbatim; CLI locals exist.
  const names = cliSlashCommands().map((cmd) => cmd.name);
  check(
    'slash: shared prompts + CLI locals are registered',
    ['review', 'init', 'commit', 'model', 'sessions', 'exit'].every((n) => names.includes(n)),
  );
  const review = resolveCliSlash('/review auth flow');
  check(
    'slash: /review expands with its argument',
    review?.command.kind === 'prompt' && review.command.expand(review.arg).includes('auth flow'),
  );
  check('slash: unknown command resolves null', resolveCliSlash('/nope') === null);
}

/* ── main ─────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  checkPureModules();

  const { deps, sends } = mockDeps({ extras: EXTRAS });
  const server = http.createServer((req, res) => {
    void handleRequest(req, res, deps);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  // Sandbox the CLI's prefs/handshake lookups away from any real install.
  const sandbox = mkdtempSync(path.join(tmpdir(), 'cli-harness-'));

  const runCli = (args: string[], token: string): Promise<{ code: number | null; out: string }> =>
    new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [
          '--experimental-strip-types',
          '--import',
          // file URL, not a bare path — a Windows drive letter would otherwise
          // parse as a protocol in the module-specifier position.
          pathToFileURL(path.join(PKG_ROOT, 'electron', 'server', 'harness-register.mjs')).href,
          path.join(PKG_ROOT, 'cli', 'main.ts'),
          '--url',
          url,
          '--token',
          token,
          ...args,
        ],
        {
          cwd: PKG_ROOT,
          env: { ...process.env, APPDATA: sandbox, XDG_CONFIG_HOME: sandbox, NODE_NO_WARNINGS: '1' },
        },
      );
      const chunks: Buffer[] = [];
      child.stdout.on('data', (d: Buffer) => chunks.push(d));
      child.stderr.on('data', (d: Buffer) => chunks.push(d));
      const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, out: Buffer.concat(chunks).toString('utf8') });
      });
    });

  try {
    // ── layer 1: the real CLI end-to-end (line mode) ──
    // First, BEFORE any --provider/--model run persists prefs in the sandbox:
    // a model-less line-mode run must fail with guidance.
    const noModel = await runCli(['--line', '--prompt', 'x'], TOKEN);
    check(
      'cli: line mode without a model fails with guidance',
      noModel.code !== 0 && /no model/i.test(noModel.out),
    );

    const ok = await runCli(
      ['--provider', 'ollama', '--model', 'mock-model', '--prompt', 'hello world'],
      TOKEN,
    );
    check('cli: one-shot run exits 0', ok.code === 0);
    check('cli: connects and reports the bridge version', ok.out.includes('0.0.0-cli-harness'));
    check('cli: the prompt reached startTurn', sends[0]?.prompt === 'hello world');
    check(
      'cli: provider/model flags are forwarded',
      sends[0]?.provider === 'ollama' && sends[0]?.model === 'mock-model',
    );
    check('cli: streamed assistant text is rendered', ok.out.includes('Hello from the mock loop.'));
    check('cli: completion summary is printed', ok.out.includes('done'));

    const bad = await runCli(
      ['--provider', 'ollama', '--model', 'mock-model', '--prompt', 'x'],
      'wrong-token',
    );
    check('cli: a bad token fails the run', bad.code !== 0);
    check('cli: the auth failure is surfaced', /unauthorized|could not reach/i.test(bad.out));

    // ── layer 2a: catalog routes on the guarded-router surface ──
    const models = await fetchJson(url, '/agent/models');
    const modelsBody = models.body as { providers?: { id: string; connected: boolean }[] };
    check(
      'routes: /agent/models lists providers + connection state',
      models.status === 200 &&
        modelsBody.providers?.length === 2 &&
        modelsBody.providers[0].connected === true,
    );
    const sessions = await fetchJson(url, '/agent/sessions');
    check(
      'routes: /agent/sessions lists summaries',
      sessions.status === 200 && (sessions.body as unknown[]).length === 1,
    );
    const resume = await fetchJson(url, '/agent/resume-session', {
      method: 'POST',
      body: JSON.stringify({ id: 'sess-1' }),
    });
    check(
      'routes: /agent/resume-session resumes by id',
      resume.status === 200 && (resume.body as { ok: boolean }).ok === true,
    );
    const badResume = await fetchJson(url, '/agent/resume-session', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    check('routes: resume without an id is a 400', badResume.status === 400);

    // ── workspace-aware catalog (mobile workspace/session picker) ──
    const workspaces = await fetchJson(url, '/agent/workspaces');
    const workspacesBody = workspaces.body as {
      workspaces?: { id: string; name: string }[];
      activeWorkspaceId?: string | null;
    };
    check(
      'routes: /agent/workspaces lists workspaces + the active one',
      workspaces.status === 200 &&
        workspacesBody.workspaces?.length === 1 &&
        workspacesBody.workspaces[0].id === 'ws-1' &&
        workspacesBody.activeWorkspaceId === 'ws-1',
    );
    check(
      'routes: /agent/sessions without a param lists every session (undefined filter)',
      extrasCalls.sessionFilters.at(-1) === undefined,
    );
    await fetchJson(url, '/agent/sessions?workspace=ws-1');
    check(
      'routes: /agent/sessions?workspace=<id> threads the workspace filter',
      extrasCalls.sessionFilters.at(-1) === 'ws-1',
    );
    await fetchJson(url, '/agent/sessions?workspace=');
    check(
      'routes: /agent/sessions?workspace= (empty) filters to global-only (null)',
      extrasCalls.sessionFilters.at(-1) === null,
    );
    await fetchJson(url, '/agent/resume-session', {
      method: 'POST',
      body: JSON.stringify({ id: 'sess-1', workspaceId: 'ws-1' }),
    });
    check(
      'routes: resume-session threads workspaceId to the backend',
      extrasCalls.resumes.at(-1)?.workspaceId === 'ws-1',
    );

    // extras omitted ⇒ the catalog routes 404 (older servers stay coherent).
    const bare = mockDeps();
    const bareServer = http.createServer((req, res) => {
      void handleRequest(req, res, bare.deps);
    });
    await new Promise<void>((resolve) => bareServer.listen(0, '127.0.0.1', resolve));
    const barePort = (bareServer.address() as AddressInfo).port;
    const missing = await fetchJson(`http://127.0.0.1:${barePort}`, '/agent/models');
    check('routes: /agent/models 404s without the extras dep', missing.status === 404);
    bareServer.close();

    // ── layer 2b: the companion lifecycle + the L-1 contrast ──
    const handshake = path.join(sandbox, 'cli-bridge.json');
    const companionDeps = mockDeps({ extras: EXTRAS });
    const companion = await startCompanionServer({
      deps: companionDeps.deps,
      handshakeFile: handshake,
    });
    check('companion: binds loopback', companion.url.startsWith('http://127.0.0.1:'));
    const written = JSON.parse(readFileSync(handshake, 'utf8')) as {
      port: number;
      token: string;
      version: string;
    };
    check(
      'companion: handshake file carries port/token/version',
      written.port === companion.port && written.token === TOKEN && written.version === '0.0.0-cli-harness',
    );
    const health = await fetchJson(companion.url, '/health');
    check('companion: serves the shared router', health.status === 200);
    // NO approval guard here: a gated-tool approve goes through (the desktop-
    // trust property that makes the CLI a full chat surface)…
    const approve = await fetchJson(companion.url, '/agent/approve', {
      method: 'POST',
      body: JSON.stringify({ turnId: 'turn-cli', callId: 'call-gated', approved: true }),
    });
    check(
      'companion: gated approve is allowed (no L-1 guard)',
      approve.status === 200 && (approve.body as { ok: boolean }).ok === true,
    );
    // …while the SAME approve against a guarded router (the remote server's
    // shape) is still refused — L-1 unchanged where it matters.
    const guarded = mockDeps({
      approvalGuard: { serverExposed: () => true, isGated: (name) => name === 'eval_js' },
    });
    const guardedServer = http.createServer((req, res) => {
      void handleRequest(req, res, guarded.deps);
    });
    await new Promise<void>((resolve) => guardedServer.listen(0, '127.0.0.1', resolve));
    const guardedPort = (guardedServer.address() as AddressInfo).port;
    const refused = await fetchJson(`http://127.0.0.1:${guardedPort}`, '/agent/approve', {
      method: 'POST',
      body: JSON.stringify({ turnId: 'turn-cli', callId: 'call-gated', approved: true }),
    });
    check(
      'guarded router: the same gated approve is refused (L-1 intact)',
      refused.status === 400 && /desktop/i.test((refused.body as { error: string }).error),
    );
    guardedServer.close();

    await companion.close();
    check('companion: close removes the handshake file', !existsSync(handshake));

    console.log(`\ncli harness: ${passedCount()} checks passed`);
  } finally {
    server.close();
    rmSync(sandbox, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('cli harness FAILED:', err);
  process.exitCode = 1;
});
