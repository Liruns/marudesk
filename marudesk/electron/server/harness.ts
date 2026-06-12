import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  AgentChatState,
  AgentEdit,
  AgentEditActionResult,
  AgentSendInput,
  AgentSendResult,
} from '../../shared/agent';
import { emptyAgentChatState } from '../../shared/agent';
import { EDIT_DIFF_TRUNCATION_MARKER } from '../../shared/edit-diff.ts';
import { REMOTE_EDIT_DIFF_MAX_CHARS } from '../../shared/remote.ts';
import { projectRemoteState } from './remote-state.ts';
import { handleRequest, type RouterDeps } from './router.ts';

/**
 * Headless harness for the bridge server's request router (docs/remote-mobile-bridge-design
 * §M4). Mirrors the repo's other headless checks (run with
 * `node --experimental-strip-types`, see package.json `harness:server`): it wires
 * the PURE router (electron/server/router.ts) to a real loopback http.Server with
 * MOCKED deps — stubbed agent fns, a fixed token, and a fake subscribe — so the
 * whole HTTP path (auth guard, JSON body, SSE) is exercised without Electron.
 *
 * Asserts: (a) 401 without/with a wrong token; (b) 200 + correct JSON on
 * /agent/snapshot with the token; (c) /agent/send routes the parsed body into the
 * injected startTurn and returns its result; (d) an SSE connect receives the
 * initial snapshot frame.
 */

const TOKEN = 'test-token-fixed-value';
const VERSION = '9.9.9-test';

type StartCall = { input: AgentSendInput };

function buildDeps(): {
  deps: RouterDeps;
  calls: {
    start: StartCall[];
    snapshotWorkspace: (string | undefined)[];
    reset: (string | undefined)[];
    effort: string[];
    revert: { editId: string; workspaceId: string | undefined }[];
  };
  emit: (state: AgentChatState) => void;
} {
  const calls = {
    start: [] as StartCall[],
    snapshotWorkspace: [] as (string | undefined)[],
    reset: [] as (string | undefined)[],
    effort: [] as string[],
    revert: [] as { editId: string; workspaceId: string | undefined }[],
  };
  // The current mocked state the snapshot() stub returns; tweaked per test. The
  // workspace-scoped twin carries a recognizable turnId so a test can tell which
  // scope a snapshot/SSE frame came from.
  const state: AgentChatState = { ...emptyAgentChatState(), status: 'idle' };
  const wsState: AgentChatState = { ...emptyAgentChatState(), status: 'idle', turnId: 'ws-42-turn' };
  // Fake subscriber registry so we can drive an SSE push from a test.
  const subs = new Set<(s: AgentChatState) => void>();
  const deps: RouterDeps = {
    token: TOKEN,
    version: VERSION,
    agent: {
      async startTurn(input: AgentSendInput): Promise<AgentSendResult> {
        calls.start.push({ input });
        return { ok: true, turnId: 'turn-from-mock' };
      },
      abortTurn(): boolean {
        return true;
      },
      respond(): boolean {
        return true;
      },
      approveTool(): boolean {
        return true;
      },
      snapshot(workspaceId?: string): AgentChatState {
        calls.snapshotWorkspace.push(workspaceId);
        return workspaceId === 'ws-42' ? wsState : state;
      },
      reset(workspaceId?: string): boolean {
        calls.reset.push(workspaceId);
        return true;
      },
      editPlanStep(): boolean {
        return true;
      },
      setApprovalMode(): boolean {
        return true;
      },
      setReasoningEffort(effort): boolean {
        calls.effort.push(effort);
        return true;
      },
      // Mirrors the loop's revertEdit: a recognizable id refuses as stale so the
      // harness can assert the refusal surfaces as a 4xx with a reason message.
      revertEdit(editId, workspaceId): Promise<AgentEditActionResult> {
        calls.revert.push({ editId, workspaceId });
        return Promise.resolve(
          editId === 'edit-stale' ? { ok: false, reason: 'stale' } : { ok: true },
        );
      },
    },
    subscribe(cb): () => void {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    // Workspace-scoped stream: the harness only needs it for the `?workspace=`
    // SSE path; production filters the loop's per-workspace fan-out the same way.
    subscribeWorkspace(): () => void {
      return () => {};
    },
  };
  const emit = (next: AgentChatState): void => {
    for (const cb of subs) cb(next);
  };
  return { deps, calls, emit };
}

type Reply = { status: number; body: string; headers: http.IncomingHttpHeaders };

/** One non-streaming request → buffered reply. */
function request(
  port: number,
  method: string,
  path: string,
  opts: { token?: string; json?: unknown; contentType?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = opts.json === undefined ? undefined : JSON.stringify(opts.json);
    const headers: Record<string, string> = {};
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (payload !== undefined) {
      headers['content-type'] = opts.contentType ?? 'application/json';
      headers['content-length'] = String(Buffer.byteLength(payload));
    }
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
          headers: res.headers,
        }),
      );
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** Open an SSE connection and resolve with the first `data:` frame's JSON. */
function firstSseEvent(port: number, token: string, path = '/agent/events'): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'GET',
        path,
        headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
      },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`SSE expected 200, got ${res.statusCode}`));
          return;
        }
        let buf = '';
        res.on('data', (c: Buffer) => {
          buf += c.toString('utf8');
          const idx = buf.indexOf('\n\n');
          if (idx === -1) return;
          const frame = buf.slice(0, idx);
          const line = frame.split('\n').find((l) => l.startsWith('data: '));
          if (!line) return; // a ping comment; keep waiting
          req.destroy();
          try {
            resolve(JSON.parse(line.slice('data: '.length)));
          } catch (err) {
            reject(err);
          }
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
    setTimeout(() => {
      req.destroy();
      reject(new Error('SSE timed out waiting for the initial snapshot'));
    }, 4000).unref();
  });
}

/**
 * Open an SSE connection and resolve once the response status line arrives,
 * handing back the status + a destroy fn so a test can hold streams open to
 * exercise the concurrent-stream cap.
 */
function openSse(port: number, token: string): Promise<{ status: number; destroy: () => void }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: '/agent/events',
        headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
      },
      (res) => {
        res.resume(); // drain frames so the socket doesn't backpressure
        resolve({ status: res.statusCode ?? 0, destroy: () => req.destroy() });
      },
    );
    req.on('error', reject);
    req.end();
    setTimeout(() => {
      req.destroy();
      reject(new Error('SSE open timed out'));
    }, 4000).unref();
  });
}

async function main(): Promise<void> {
  const { deps, calls } = buildDeps();
  const server = http.createServer((req, res) => {
    void handleRequest(req, res, deps);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  let passed = 0;
  const check = (label: string, cond: boolean): void => {
    assert.ok(cond, label);
    passed += 1;
    console.log(`  ok ${passed} - ${label}`);
  };

  try {
    // (a) 401 without a token, and with a wrong token — for every route.
    const noTok = await request(port, 'GET', '/agent/snapshot');
    check('GET /agent/snapshot without a token → 401', noTok.status === 401);

    const badTok = await request(port, 'GET', '/agent/snapshot', { token: 'wrong' });
    check('GET /agent/snapshot with a wrong token → 401', badTok.status === 401);

    const healthNoTok = await request(port, 'GET', '/health');
    check('GET /health still requires a token → 401', healthNoTok.status === 401);

    // (b) 200 + correct JSON on /agent/snapshot with the token.
    const snap = await request(port, 'GET', '/agent/snapshot', { token: TOKEN });
    check('GET /agent/snapshot with the token → 200', snap.status === 200);
    const snapJson = JSON.parse(snap.body) as AgentChatState;
    check('snapshot body is the AgentChatState', snapJson.status === 'idle' && Array.isArray(snapJson.messages));

    // /health sanity with the token.
    const health = await request(port, 'GET', '/health', { token: TOKEN });
    const healthJson = JSON.parse(health.body) as { ok: boolean; name: string; version: string };
    check(
      'GET /health with the token → 200 + {ok,name,version}',
      health.status === 200 && healthJson.ok === true && healthJson.name === 'marudesk' && healthJson.version === VERSION,
    );

    // (c) /agent/send routes the parsed body into startTurn and returns its result.
    const sendBody = { provider: 'anthropic', model: 'claude-x', prompt: 'hi there', captures: [] };
    const send = await request(port, 'POST', '/agent/send', { token: TOKEN, json: sendBody });
    check('POST /agent/send → 200', send.status === 200);
    const sendJson = JSON.parse(send.body) as AgentSendResult;
    check(
      'POST /agent/send returns the injected startTurn result',
      sendJson.ok === true && sendJson.turnId === 'turn-from-mock',
    );
    check('startTurn was called exactly once', calls.start.length === 1);
    check(
      'startTurn received the parsed body (provider/model/prompt)',
      calls.start[0].input.provider === 'anthropic' &&
        calls.start[0].input.model === 'claude-x' &&
        calls.start[0].input.prompt === 'hi there',
    );

    // Bad send body is rejected (validation reused from the IPC parsers).
    const badSend = await request(port, 'POST', '/agent/send', { token: TOKEN, json: { provider: 'nope' } });
    check('POST /agent/send with a bad body → 400', badSend.status === 400);
    check('a rejected send did NOT call startTurn again', calls.start.length === 1);

    // Wrong content type on a POST is rejected before parsing.
    const wrongCtype = await request(port, 'POST', '/agent/send', {
      token: TOKEN,
      json: sendBody,
      contentType: 'text/plain',
    });
    check('POST with a non-JSON content type → 415', wrongCtype.status === 415);

    // Method + unknown-route guards.
    const wrongMethod = await request(port, 'POST', '/agent/snapshot', { token: TOKEN });
    check('POST /agent/snapshot (GET-only) → 405', wrongMethod.status === 405);
    const unknown = await request(port, 'GET', '/nope', { token: TOKEN });
    check('unknown route → 404', unknown.status === 404);

    // (d) SSE connect receives the initial snapshot as the first event.
    const firstEvent = (await firstSseEvent(port, TOKEN)) as { type: string; state: AgentChatState };
    check(
      'GET /agent/events first frame is the snapshot event',
      firstEvent.type === 'snapshot' && firstEvent.state.status === 'idle',
    );

    // (e) workspace scoping: `?workspace=` reaches the agent api on snapshot/SSE,
    // and a `{ workspaceId }` body scopes reset.
    const globalSnapshots = calls.snapshotWorkspace.length;
    const wsSnap = await request(port, 'GET', '/agent/snapshot?workspace=ws-42', { token: TOKEN });
    const wsSnapJson = JSON.parse(wsSnap.body) as AgentChatState;
    check(
      'GET /agent/snapshot?workspace=ws-42 returns that workspace state',
      wsSnap.status === 200 && wsSnapJson.turnId === 'ws-42-turn',
    );
    check(
      'the workspace param reached agent.snapshot()',
      calls.snapshotWorkspace[globalSnapshots] === 'ws-42',
    );

    const wsFirstEvent = (await firstSseEvent(port, TOKEN, '/agent/events?workspace=ws-42')) as {
      type: string;
      state: AgentChatState;
    };
    check(
      'GET /agent/events?workspace=ws-42 first frame is that workspace snapshot',
      wsFirstEvent.type === 'snapshot' && wsFirstEvent.state.turnId === 'ws-42-turn',
    );

    const wsReset = await request(port, 'POST', '/agent/reset', {
      token: TOKEN,
      json: { workspaceId: 'ws-42' },
    });
    check('POST /agent/reset {workspaceId} → 200', wsReset.status === 200);
    check('the workspaceId reached agent.reset()', calls.reset.at(-1) === 'ws-42');
    const globalReset = await request(port, 'POST', '/agent/reset', { token: TOKEN, json: {} });
    check(
      'POST /agent/reset {} stays global (undefined workspace)',
      globalReset.status === 200 && calls.reset.at(-1) === undefined,
    );

    // (f) set-reasoning-effort: validated + forwarded, like set-approval-mode.
    const effortOk = await request(port, 'POST', '/agent/set-reasoning-effort', {
      token: TOKEN,
      json: { effort: 'high' },
    });
    check(
      'POST /agent/set-reasoning-effort {effort:high} → 200 {ok:true}',
      effortOk.status === 200 && (JSON.parse(effortOk.body) as { ok: boolean }).ok === true,
    );
    check('the effort reached agent.setReasoningEffort()', calls.effort.at(-1) === 'high');
    const effortBad = await request(port, 'POST', '/agent/set-reasoning-effort', {
      token: TOKEN,
      json: { effort: 'extreme' },
    });
    check('an unknown effort → 400', effortBad.status === 400);
    check('a rejected effort did NOT reach the loop', calls.effort.length === 1);

    // (h) revert-edit: validated + forwarded; a loop refusal surfaces as a 400
    // with the human-readable reason (phone patch review).
    const revertOk = await request(port, 'POST', '/agent/revert-edit', {
      token: TOKEN,
      json: { editId: 'edit-1', workspaceId: 'ws-42' },
    });
    check(
      'POST /agent/revert-edit {editId,workspaceId} → 200 {ok:true}',
      revertOk.status === 200 && (JSON.parse(revertOk.body) as { ok: boolean }).ok === true,
    );
    check(
      'the edit id + workspace reached agent.revertEdit()',
      calls.revert.at(-1)?.editId === 'edit-1' && calls.revert.at(-1)?.workspaceId === 'ws-42',
    );
    const revertStale = await request(port, 'POST', '/agent/revert-edit', {
      token: TOKEN,
      json: { editId: 'edit-stale' },
    });
    check(
      'a stale revert refusal → 400 with the reason message',
      revertStale.status === 400 &&
        (JSON.parse(revertStale.body) as { error: string }).error.includes('changed since'),
    );
    const revertBad = await request(port, 'POST', '/agent/revert-edit', { token: TOKEN, json: {} });
    check('POST /agent/revert-edit without an editId → 400', revertBad.status === 400);
    check('a rejected revert did NOT reach the loop', calls.revert.length === 2);

    // (i) remote edit projection (remote-state.ts): the heavy before/after edit
    // list becomes a bounded unified-diff view; the authoritative input state is
    // never mutated.
    const edit: AgentEdit = {
      id: 'edit-proj-1',
      turnId: 'turn-9',
      path: 'src/App.tsx',
      kind: 'edit',
      before: 'a\nb\nc\nd\n',
      after: 'a\nB!\nc\nd\n',
      status: 'applied',
      timestamp: 123,
    };
    const richState: AgentChatState = { ...emptyAgentChatState(), edits: [edit] };
    const projected = projectRemoteState(richState);
    const pd = projected.editDiffs?.[0];
    check(
      'projectRemoteState stamps editDiffs (id/label/status/turn ride along)',
      pd !== undefined &&
        pd.id === 'edit-proj-1' &&
        pd.turnId === 'turn-9' &&
        pd.label === 'src/App.tsx' &&
        pd.status === 'applied' &&
        pd.kind === 'edit',
    );
    check(
      'the projected diff is a unified hunk with +/- lines and counts',
      pd !== undefined &&
        pd.additions === 1 &&
        pd.deletions === 1 &&
        pd.diff.includes('@@') &&
        pd.diff.includes('-b') &&
        pd.diff.includes('+B!'),
    );
    check(
      'the heavy edits array is emptied on the wire but untouched in the input',
      projected.edits.length === 0 && richState.edits.length === 1,
    );
    check(
      'a state without edits passes through unchanged (no editDiffs field)',
      projectRemoteState(emptyAgentChatState()).editDiffs === undefined,
    );
    const bigEdit: AgentEdit = {
      ...edit,
      id: 'edit-proj-big',
      before: null,
      after: Array.from({ length: 4000 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n'),
      kind: 'create',
    };
    const bigDiff = projectRemoteState({ ...emptyAgentChatState(), edits: [bigEdit] })
      .editDiffs?.[0];
    check(
      'an oversized diff is clipped at the budget with the truncation marker',
      bigDiff !== undefined &&
        bigDiff.truncated === true &&
        bigDiff.diff.length <= REMOTE_EDIT_DIFF_MAX_CHARS + EDIT_DIFF_TRUNCATION_MARKER.length + 1 &&
        bigDiff.diff.endsWith(EDIT_DIFF_TRUNCATION_MARKER) &&
        bigDiff.additions === 4000,
    );

    // (g) a workspace-scoped SSE request is refused when the deps can't serve it
    // (e.g. an older embedder without the workspace fan-out).
    const bareDeps: RouterDeps = { ...deps, subscribeWorkspace: undefined };
    const bareServer = http.createServer((req, res) => {
      void handleRequest(req, res, bareDeps);
    });
    await new Promise<void>((resolve) => bareServer.listen(0, '127.0.0.1', resolve));
    const barePort = (bareServer.address() as AddressInfo).port;
    try {
      const refused = await request(barePort, 'GET', '/agent/events?workspace=ws-42', { token: TOKEN });
      check('events?workspace without subscribeWorkspace → 400', refused.status === 400);
    } finally {
      bareServer.close();
    }

    // (j) the concurrent SSE cap (M-1+): past the cap a connect is shed with a
    // 503, and closing a stream frees the slot.
    const cappedDeps: RouterDeps = { ...deps, maxSseClients: 2 };
    const cappedServer = http.createServer((req, res) => {
      void handleRequest(req, res, cappedDeps);
    });
    await new Promise<void>((resolve) => cappedServer.listen(0, '127.0.0.1', resolve));
    const cappedPort = (cappedServer.address() as AddressInfo).port;
    try {
      const s1 = await openSse(cappedPort, TOKEN);
      const s2 = await openSse(cappedPort, TOKEN);
      check('SSE streams up to the cap connect (200)', s1.status === 200 && s2.status === 200);
      const s3 = await openSse(cappedPort, TOKEN);
      check('an SSE stream past the cap is shed with a 503', s3.status === 503);
      s1.destroy();
      // The close propagates async; poll briefly for the freed slot.
      let freed = 0;
      for (let i = 0; i < 20; i += 1) {
        const retry = await openSse(cappedPort, TOKEN);
        freed = retry.status;
        if (freed === 200) {
          retry.destroy();
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      check('closing a stream frees a slot under the cap', freed === 200);
      s2.destroy();
      s3.destroy();
    } finally {
      cappedServer.close();
    }

    console.log(`\nbridge-server harness: ${passed} assertions passed`);
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error('bridge-server harness FAILED:', err);
  process.exitCode = 1;
});
