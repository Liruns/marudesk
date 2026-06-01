import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import type { AgentChatState, AgentSendInput, AgentSendResult } from '../../shared/agent';
import { emptyAgentChatState } from '../../shared/agent';
import {
  parseRelayHostMessage,
  type RelayCommand,
  type RelayHostMessage,
} from '../../shared/remote';
import type { AgentApi } from './dispatch';
import { startRelayClient, type RelayClient } from './relay-client';

/**
 * Cross-package headless e2e for the Bridge Model B PC host (electron/server/
 * relay-client.ts). Run with `npm run harness:relay-bridge`. Mirrors the repo's
 * other headless checks (node --experimental-strip-types) and the relay's own
 * harness style: it spawns the REAL B1 relay (C:/toy-prj/relay) on an ephemeral
 * port, signs up + logs in over HTTP for a JWT, starts the PC relay-client as the
 * account's HOST with a STUBBED agent loop, opens a second WS as a mock CLIENT on
 * the same account, and asserts the full round-trip through the cloud relay:
 *
 *   - the mock client sends {k:'cmd',cmd:'snapshot'} → receives an {k:'ack',ok}
 *     AND an {k:'event',state} AgentChatState back through the relay;
 *   - a {k:'cmd',cmd:'send',...} dispatches to the stubbed loop's startTurn with
 *     the SHARED parser-validated args (proving relay + REST share one dispatch);
 *   - a malformed/unknown command is acked ok:false (untrusted peer input).
 *
 * Everything is torn down in a finally (client.stop, sockets closed, relay process
 * killed) so the harness leaves no orphan listeners or processes.
 */

const RELAY_DIR = path.resolve(fileURLToPath(import.meta.url), '../../../../relay');
const JWT_SECRET = 'relay-bridge-harness-secret-value-1234567890';

/* ── spawn the real relay + read its bound port from stdout ────────────────── */

type SpawnedRelay = { proc: ChildProcessWithoutNullStreams; baseUrl: string };

function spawnRelay(): Promise<SpawnedRelay> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      ['--experimental-strip-types', 'src/index.ts'],
      {
        cwd: RELAY_DIR,
        env: { ...process.env, PORT: '0', HOST: '127.0.0.1', JWT_SECRET, AUTH_RATE_BURST: '1000' },
      },
    );
    let out = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      reject(new Error(`relay did not report a listening port in time; stdout so far:\n${out}`));
    }, 15_000);
    timer.unref();
    proc.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
      // First log line: "[relay] listening on http://127.0.0.1:<port>  (oauth: …)".
      const m = /listening on (http:\/\/127\.0\.0\.1:(\d+))/.exec(out);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ proc, baseUrl: m[1]! });
      }
    });
    proc.stderr.on('data', () => {
      /* relay warns about the ephemeral secret; ignore */
    });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    proc.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`relay exited early (code ${code}); stdout:\n${out}`));
    });
  });
}

function killRelay(relay: SpawnedRelay): Promise<void> {
  return new Promise((resolve) => {
    if (relay.proc.exitCode !== null || relay.proc.killed) return resolve();
    relay.proc.once('exit', () => resolve());
    relay.proc.kill();
    setTimeout(() => {
      if (relay.proc.exitCode === null) relay.proc.kill('SIGKILL');
      resolve();
    }, 3_000).unref();
  });
}

/* ── HTTP helper (signup/login) ────────────────────────────────────────────── */

function http(
  baseUrl: string,
  method: string,
  pathName: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + pathName);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {};
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(payload));
    }
    const req = httpRequest(
      { host: u.hostname, port: u.port, method, path: u.pathname, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown;
          try {
            json = text.length ? JSON.parse(text) : null;
          } catch {
            json = text;
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/* ── a mock CLIENT WS on the relay (the future phone, B3) ──────────────────── */

type MockClient = {
  ws: WebSocket;
  /** Send an app-level command (wrapped in the relay's `{payload}` envelope). */
  send(cmd: RelayCommand): void;
  /** Resolve with the next host message (event/ack) matching `predicate`. */
  next(predicate: (m: RelayHostMessage) => boolean, timeoutMs?: number): Promise<RelayHostMessage>;
  close(): Promise<void>;
};

function connectMockClient(baseUrl: string, token: string): Promise<MockClient> {
  const wsUrl = baseUrl.replace(/^http/, 'ws') + `/connect?role=client&token=${encodeURIComponent(token)}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const onErr = (): void => reject(new Error('mock client failed to connect'));
    ws.addEventListener('error', onErr, { once: true });
    ws.addEventListener(
      'open',
      () => {
        ws.removeEventListener('error', onErr);
        resolve({
          ws,
          send(cmd) {
            ws.send(JSON.stringify({ payload: cmd }));
          },
          next(predicate, timeoutMs = 4_000) {
            return new Promise((res, rej) => {
              const timer = setTimeout(() => {
                ws.removeEventListener('message', onMsg);
                rej(new Error('timed out waiting for a host message'));
              }, timeoutMs);
              timer.unref();
              const onMsg = (ev: { data: unknown }): void => {
                let frame: { type?: unknown; payload?: unknown };
                try {
                  frame = JSON.parse(String(ev.data)) as typeof frame;
                } catch {
                  return;
                }
                if (frame.type !== 'relay') return; // skip 'ready' etc.
                const msg = parseRelayHostMessage(frame.payload);
                if (!msg || !predicate(msg)) return;
                clearTimeout(timer);
                ws.removeEventListener('message', onMsg);
                res(msg);
              };
              ws.addEventListener('message', onMsg);
            });
          },
          close() {
            return new Promise((res) => {
              if (ws.readyState === ws.CLOSED) return res();
              ws.addEventListener('close', () => res(), { once: true });
              ws.close();
            });
          },
        });
      },
      { once: true },
    );
  });
}

/* ── a stubbed agent loop (records calls; drives the event subscriber) ─────── */

function buildStubAgent(): {
  agent: AgentApi;
  subscribe: (cb: (s: AgentChatState) => void) => () => void;
  emit: (s: AgentChatState) => void;
  calls: { startTurn: AgentSendInput[]; reset: number };
} {
  const calls = { startTurn: [] as AgentSendInput[], reset: 0 };
  const state: AgentChatState = { ...emptyAgentChatState(), status: 'idle' };
  const subs = new Set<(s: AgentChatState) => void>();
  const agent: AgentApi = {
    async startTurn(input: AgentSendInput): Promise<AgentSendResult> {
      calls.startTurn.push(input);
      return { ok: true, turnId: 'turn-from-stub' };
    },
    abortTurn: () => true,
    respond: () => true,
    approveTool: () => true,
    snapshot: () => state,
    reset: () => {
      calls.reset += 1;
      return true;
    },
  };
  return {
    agent,
    subscribe: (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    emit: (s) => {
      for (const cb of subs) cb(s);
    },
    calls,
  };
}

/* ── main ──────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  let passed = 0;
  const check = (label: string, cond: boolean): void => {
    assert.ok(cond, label);
    passed += 1;
    console.log(`  ok ${passed} - ${label}`);
  };

  const relay = await spawnRelay();
  let client: RelayClient | null = null;
  let mock: MockClient | null = null;
  try {
    check('real relay spawned + reported a port', /^http:\/\/127\.0\.0\.1:\d+$/.test(relay.baseUrl));

    // ── sign up + log in (account A) → JWT ──────────────────────────────────
    const email = `host-${Date.now()}@example.com`;
    const password = 'correct-horse-battery';
    const signup = await http(relay.baseUrl, 'POST', '/auth/signup', { email, password });
    check('POST /auth/signup → 201', signup.status === 201);
    const login = await http(relay.baseUrl, 'POST', '/auth/login', { email, password });
    check('POST /auth/login → 200 with a token', login.status === 200);
    const { accessToken, refreshToken } = login.json as {
      accessToken: string;
      refreshToken: string;
    };
    check('login returned an access + refresh token', !!accessToken && !!refreshToken);

    // ── start the PC relay-client as HOST with a stubbed loop ───────────────
    const stub = buildStubAgent();
    let hostConnected = false;
    client = startRelayClient({
      relayUrl: relay.baseUrl,
      accessToken,
      refreshToken,
      agent: stub.agent,
      subscribe: stub.subscribe,
      onConnectedChange: (c) => {
        hostConnected = c;
      },
    });

    // Wait for the host to actually connect (poll its flag briefly).
    for (let i = 0; i < 100 && !client.isConnected(); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    check('PC relay-client connected to the relay as host', client.isConnected() && hostConnected);

    // ── open a mock CLIENT on the SAME account ──────────────────────────────
    mock = await connectMockClient(relay.baseUrl, accessToken);
    check('mock client connected to the relay', mock.ws.readyState === mock.ws.OPEN);

    // ── snapshot: client → host → ack carrying the AgentChatState ───────────
    const ackP = mock.next((m) => m.k === 'ack' && m.cid === 'cid-snap');
    mock.send({ k: 'cmd', cid: 'cid-snap', cmd: 'snapshot', args: undefined });
    const ack = await ackP;
    check(
      'snapshot command → {k:ack, ok:true} back through the relay',
      ack.k === 'ack' && ack.ok === true && ack.cid === 'cid-snap',
    );
    const ackState = (ack as { result?: AgentChatState }).result;
    check(
      "the ack's result is the AgentChatState snapshot",
      !!ackState && ackState.status === 'idle' && Array.isArray(ackState.messages),
    );

    // ── a loop-emitted agent:event is forwarded to the client as {k:event} ──
    // (the subscribeAgentEvents → relay push path). Emitted AFTER the client is
    // connected so the relay brokers it — the on-connect snapshot push targets a
    // phone that connected first, which is the `snapshot` command's job here.
    const workingP = mock.next(
      (m) => m.k === 'event' && (m as { state: AgentChatState }).state.status === 'working',
    );
    stub.emit({ ...emptyAgentChatState(), status: 'working' });
    const working = await workingP;
    check(
      'a loop-emitted {k:event, state} AgentChatState is relayed to the client',
      working.k === 'event' &&
        (working as { state: AgentChatState }).state.status === 'working' &&
        Array.isArray((working as { state: AgentChatState }).state.messages),
    );

    // ── send: dispatches to the stubbed loop with parser-validated args ─────
    const sendAckP = mock.next((m) => m.k === 'ack' && m.cid === 'cid-send');
    mock.send({
      k: 'cmd',
      cid: 'cid-send',
      cmd: 'send',
      args: { provider: 'anthropic', model: 'claude-x', prompt: 'hi from phone', captures: [] },
    });
    const sendAck = await sendAckP;
    check(
      'send command → {k:ack, ok:true} with startTurn result',
      sendAck.k === 'ack' &&
        sendAck.ok === true &&
        (sendAck as { result?: AgentSendResult }).result !== undefined &&
        ((sendAck as { result: AgentSendResult }).result as { turnId?: string }).turnId === 'turn-from-stub',
    );
    check('the command dispatched to the stubbed loop.startTurn exactly once', stub.calls.startTurn.length === 1);
    check(
      'startTurn received the SHARED-parser-validated args (provider/model/prompt)',
      stub.calls.startTurn[0]!.provider === 'anthropic' &&
        stub.calls.startTurn[0]!.model === 'claude-x' &&
        stub.calls.startTurn[0]!.prompt === 'hi from phone',
    );

    // ── a malformed command is acked ok:false (untrusted peer input) ────────
    const badAckP = mock.next((m) => m.k === 'ack' && m.cid === 'cid-bad');
    mock.send({ k: 'cmd', cid: 'cid-bad', cmd: 'send', args: { provider: 'not-a-provider' } });
    const badAck = await badAckP;
    check(
      'a malformed send → {k:ack, ok:false, error} (validation, not a crash)',
      badAck.k === 'ack' && badAck.ok === false && typeof (badAck as { error?: string }).error === 'string',
    );
    check('the rejected command did NOT call startTurn again', stub.calls.startTurn.length === 1);

    // ── reset dispatches to the loop too ────────────────────────────────────
    const resetAckP = mock.next((m) => m.k === 'ack' && m.cid === 'cid-reset');
    mock.send({ k: 'cmd', cid: 'cid-reset', cmd: 'reset', args: undefined });
    const resetAck = await resetAckP;
    check('reset command → {k:ack, ok:true}', resetAck.k === 'ack' && resetAck.ok === true);
    check('reset dispatched to the stubbed loop.reset', stub.calls.reset === 1);

    console.log(`\nrelay-bridge harness: ${passed} assertions passed`);
  } finally {
    if (mock) await mock.close();
    client?.stop();
    await killRelay(relay);
  }
}

main().catch((err) => {
  console.error('relay-bridge harness FAILED:', err);
  process.exitCode = 1;
});
