import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentChatState, AgentSendInput, AgentSendResult } from '../../shared/agent';
import { emptyAgentChatState } from '../../shared/agent';
import { check, passedCount } from '../harness-kit';
import { handleRequest, type RouterDeps } from './router.ts';

/**
 * Headless harness for the terminal chat client (scripts/chat-cli.mjs). Boots
 * the PURE router on a loopback http.Server with a mocked agent — startTurn
 * acknowledges, then the mock streams snapshots (thinking → text deltas →
 * completed) through the subscribe registry, exactly what the real loop emits —
 * and runs the actual CLI as a child process in one-shot mode. Asserts the CLI
 * authenticates, sends the parsed prompt, renders the streamed text, reports
 * completion (exit 0), and fails cleanly on a bad token (non-zero exit).
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

async function main(): Promise<void> {
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
      snapshot: () => ({ ...emptyAgentChatState(), status: 'idle' }),
      reset: () => true,
      editPlanStep: () => true,
      setApprovalMode: () => true,
    },
    subscribe(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
  };

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
        [path.join(PKG_ROOT, 'scripts', 'chat-cli.mjs'), '--url', url, '--token', token, ...args],
        {
          cwd: PKG_ROOT,
          env: { ...process.env, APPDATA: sandbox, XDG_CONFIG_HOME: sandbox },
        },
      );
      const chunks: Buffer[] = [];
      child.stdout.on('data', (d) => chunks.push(d));
      child.stderr.on('data', (d) => chunks.push(d));
      const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, out: Buffer.concat(chunks).toString('utf8') });
      });
    });

  try {
    const ok = await runCli(
      ['--provider', 'ollama', '--model', 'mock-model', '--prompt', 'hello world'],
      TOKEN,
    );
    check('cli: one-shot run exits 0', ok.code === 0);
    check('cli: connects and reports the bridge version', ok.out.includes('0.0.0-cli-harness'));
    check('cli: the prompt reached startTurn', sends[0]?.prompt === 'hello world');
    check('cli: provider/model flags are forwarded', sends[0]?.provider === 'ollama' && sends[0]?.model === 'mock-model');
    check('cli: streamed assistant text is rendered', ok.out.includes('Hello from the mock loop.'));
    check('cli: completion summary is printed', ok.out.includes('done'));

    const bad = await runCli(['--provider', 'ollama', '--model', 'mock-model', '--prompt', 'x'], 'wrong-token');
    check('cli: a bad token fails the run', bad.code !== 0);
    check('cli: the auth failure is surfaced', /unauthorized|could not reach/i.test(bad.out));

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
