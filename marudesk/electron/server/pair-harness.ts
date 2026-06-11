import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgentChatState, AgentSendInput, AgentSendResult } from '../../shared/agent';
import { emptyAgentChatState } from '../../shared/agent';
import {
  b64urlToBytes,
  bytesToB64url,
  decodeQrPayload,
  deriveSessionKey,
  generateKeyPair,
  importAesKey,
  makePairProof,
  open,
  reqAad,
  resAad,
  seal,
  SSE_AAD,
  type Envelope,
  type SessionKey,
} from '../../shared/e2e.ts';
import { createPairingManager } from './pairing.ts';
import { handleRequest, type RouterDeps } from './router.ts';

/**
 * Headless harness for the T2 pairing handshake + E2E envelope path
 * (docs/t2-secure-pairing-design.md §2/§3). Wires the REAL router + REAL pairing
 * manager to a loopback http.Server with a fake in-memory device store + a mocked
 * agent — no Electron, no safeStorage (run via `node --experimental-strip-types`,
 * see package.json `harness:pair`). It drives a simulated phone (decode the QR,
 * derive the key, prove possession) all the way through `/pair` + an encrypted
 * `/agent/send` + snapshot + SSE, asserts the adversarial paths, and checks the
 * L-1 guard: a bridge-relayed `approve` of a gated tool is refused while the
 * server is exposed (gated approvals stay pinned to the desktop).
 */

const TOKEN = 'bearer-token-fixed';
const VERSION = '9.9.9-test';

/** A fake device key store the pairing manager populates and the router resolves against. */
function makeDeviceStore(): {
  resolver: RouterDeps['devices'];
  add: (deviceId: string, rawKeyB64: string) => Promise<void>;
} {
  const keys = new Map<string, SessionKey>();
  return {
    resolver: {
      getKey: (deviceId) => Promise.resolve(keys.get(deviceId) ?? null),
      touch: () => {},
    },
    add: async (deviceId, rawKeyB64) => {
      keys.set(deviceId, await importAesKey(b64urlToBytes(rawKeyB64)));
    },
  };
}

type ApprovalCall = { turnId: string; callId: string; approved: boolean };

function buildDeps(approve: { mode: 'approve' | 'reject' | 'auto' }): {
  deps: RouterDeps;
  pairing: ReturnType<typeof createPairingManager>;
  cardShown: () => boolean;
  /** Controls for the L-1 self-approval assertions (drive the bridge approve path). */
  approval: {
    /** Toggle whether a bridge transport is exposed (the guard reads this live). */
    setExposed: (v: boolean) => void;
    /** Park (or clear) a tool awaiting approval, as the loop's snapshot would show it. */
    setPending: (p: { turnId: string; callId: string; name: string } | null) => void;
    /** Every approveTool() call that actually reached the mock loop (refusals never do). */
    calls: ApprovalCall[];
  };
} {
  const state: AgentChatState = { ...emptyAgentChatState(), status: 'idle' };
  const subs = new Set<(s: AgentChatState) => void>();
  const store = makeDeviceStore();
  let cards = 0;
  // L-1 fixtures: a mutable exposure flag + a small gated-tool set, injected into
  // the router via deps.approvalGuard so the dispatcher's REAL refusal logic runs
  // (production wires settings + isGatedTool here — see approval-guard.ts).
  let exposed = false;
  const GATED = new Set(['eval_js', 'browser_cookies', 'browser_storage', 'read_terminal']);
  const approveCalls: ApprovalCall[] = [];

  // `pairing` is referenced inside onPairingRequest, but that closure only runs
  // after construction returns, so the const is fully initialized by then.
  const pairing = createPairingManager({
    addDevice: (rec) => store.add(rec.deviceId, rec.key),
    onPairingRequest: (info) => {
      cards += 1;
      // 'auto' = unattended: handlePair auto-approves, so a card should never fire.
      if (approve.mode === 'auto') return;
      // Decide on a later tick, after handlePair is already awaiting the decision.
      setTimeout(() => {
        if (approve.mode === 'approve') pairing.approve(info.approvalId);
        else pairing.reject(info.approvalId);
      }, 0);
    },
    shouldAutoApprove: () => approve.mode === 'auto',
    approvalTimeoutMs: 2000,
  });

  const deps: RouterDeps = {
    token: TOKEN,
    version: VERSION,
    agent: {
      startTurn: (input: AgentSendInput): Promise<AgentSendResult> => {
        void input;
        return Promise.resolve({ ok: true, turnId: 'turn-mock' });
      },
      abortTurn: () => true,
      respond: () => true,
      // Record what actually reaches the loop — a refused (L-1) approve must NOT.
      approveTool: (turnId, callId, approved) => {
        approveCalls.push({ turnId, callId, approved });
        return true;
      },
      snapshot: () => state,
      reset: () => true,
      editPlanStep: () => true,
      setApprovalMode: () => true,
      setReasoningEffort: () => true,
    },
    subscribe: (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    devices: store.resolver,
    pair: (body) => pairing.handlePair(body),
    // The real guard wiring (production injects settings + isGatedTool); here we
    // drive both facts directly so the dispatcher's refusal is exercised, not a replica.
    approvalGuard: {
      serverExposed: () => exposed,
      isGated: (name) => GATED.has(name),
    },
  };
  return {
    deps,
    pairing,
    cardShown: () => cards > 0,
    approval: {
      setExposed: (v) => {
        exposed = v;
      },
      setPending: (p) => {
        state.pendingApproval = p ? { ...p, detail: 'preview' } : null;
      },
      calls: approveCalls,
    },
  };
}

type Reply = { status: number; body: string; headers: http.IncomingHttpHeaders };

function request(
  port: number,
  method: string,
  path: string,
  opts: { token?: string; deviceId?: string; json?: unknown } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = opts.json === undefined ? undefined : JSON.stringify(opts.json);
    const headers: Record<string, string> = {};
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.deviceId) headers['x-marudesk-device'] = opts.deviceId;
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
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

/** Open an E2E SSE connection and resolve the first encrypted frame's decoded event. */
function firstSseFrame(port: number, deviceId: string, key: SessionKey): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settling = false;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: '/agent/events',
        headers: { 'x-marudesk-device': deviceId, accept: 'text/event-stream' },
      },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`SSE expected 200, got ${res.statusCode}`));
          return;
        }
        let buf = '';
        res.on('data', (c: Buffer) => {
          if (settling) return;
          buf += c.toString('utf8');
          const idx = buf.indexOf('\n\n');
          if (idx === -1) return;
          const line = buf
            .slice(0, idx)
            .split('\n')
            .find((l) => l.startsWith('data: '));
          if (!line) return;
          // We have the first frame: stop reading + tearing down the socket will
          // fire an (expected) abort error — guard it so the open() result wins.
          settling = true;
          const env = JSON.parse(line.slice('data: '.length)) as Envelope;
          req.destroy();
          void open(key, env, SSE_AAD).then(resolve, reject);
        });
        res.on('error', (e) => {
          if (!settling) reject(e);
        });
      },
    );
    req.on('error', (e) => {
      if (!settling) reject(e);
    });
    req.end();
    setTimeout(() => {
      req.destroy();
      reject(new Error('SSE timed out'));
    }, 4000).unref();
  });
}

/** Run one full pairing handshake against the server; returns the phone's view. */
async function pairPhone(
  port: number,
  pairing: ReturnType<typeof createPairingManager>,
  deviceName: string,
): Promise<{ status: number; deviceId?: string; key: SessionKey }> {
  const start = await pairing.startPairing({ urls: [{ label: 'lan', url: `http://x:1` }], pcName: 'PC' });
  const qr = decodeQrPayload(start.qr);
  assert.ok(qr, 'phone decodes the QR');
  const phone = await generateKeyPair();
  const key = await deriveSessionKey(phone.privateKey, b64urlToBytes(qr.pcPub), qr.code);
  const proof = await makePairProof(key, qr.code);
  const reply = await request(port, 'POST', '/pair', {
    json: { code: qr.code, phPub: bytesToB64url(phone.publicKeyRaw), deviceName, proof },
  });
  if (reply.status !== 200) return { status: reply.status, key };
  const sealed = JSON.parse(reply.body) as Envelope;
  const result = (await open(key, sealed, resAad('/pair'))) as { deviceId: string };
  return { status: 200, deviceId: result.deviceId, key };
}

async function main(): Promise<void> {
  let passed = 0;
  const check = (label: string, cond: boolean): void => {
    assert.ok(cond, label);
    passed += 1;
    console.log(`  ok ${passed} - ${label}`);
  };

  // ── happy path: pair, then drive the agent over the encrypted channel ───────
  const { deps, pairing, approval } = buildDeps({ mode: 'approve' });
  const server = http.createServer((req, res) => void handleRequest(req, res, deps));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;

  try {
    const paired = await pairPhone(port, pairing, 'My Phone');
    check('POST /pair with a valid code+proof + approval → 200', paired.status === 200);
    check('the sealed /pair body opens to a deviceId', typeof paired.deviceId === 'string');
    const { deviceId, key } = paired;

    // E2E POST /agent/send: sealed body in, sealed result out.
    const sendEnv = await seal(
      key,
      { provider: 'anthropic', model: 'claude-x', prompt: 'hi', captures: [] },
      reqAad('POST', '/agent/send'),
    );
    const sendReply = await request(port, 'POST', '/agent/send', { deviceId, json: sendEnv });
    check('E2E POST /agent/send → 200', sendReply.status === 200);
    const sendResult = (await open(key, JSON.parse(sendReply.body) as Envelope, resAad('/agent/send'))) as AgentSendResult;
    check('the sealed send result is startTurn output', sendResult.ok === true && sendResult.turnId === 'turn-mock');

    // E2E GET /agent/snapshot: sealed snapshot.
    const snapReply = await request(port, 'GET', '/agent/snapshot', { deviceId });
    check('E2E GET /agent/snapshot → 200', snapReply.status === 200);
    const snap = (await open(key, JSON.parse(snapReply.body) as Envelope, resAad('/agent/snapshot'))) as AgentChatState;
    check('the sealed snapshot is the AgentChatState', snap.status === 'idle' && Array.isArray(snap.messages));

    // E2E SSE: encrypted first frame.
    const frame = (await firstSseFrame(port, deviceId!, key)) as { type: string; state: AgentChatState };
    check('E2E SSE first frame decrypts to the snapshot', frame.type === 'snapshot' && frame.state.status === 'idle');

    // ── adversarial ───────────────────────────────────────────────────────────
    const unknownDev = await request(port, 'GET', '/agent/snapshot', { deviceId: 'no-such-device' });
    check('unknown device id → 401', unknownDev.status === 401);

    // A body sealed under a DIFFERENT key (wrong device) won't open → 401.
    const stranger = await importAesKey(b64urlToBytes(bytesToB64url(new Uint8Array(32).fill(7))));
    const forged = await seal(stranger, { turnId: 'x' }, reqAad('POST', '/agent/abort'));
    const forgedReply = await request(port, 'POST', '/agent/abort', { deviceId, json: forged });
    check('an envelope sealed under the wrong key → 401', forgedReply.status === 401);

    // Tampered ciphertext on a genuine device → 401.
    const good = await seal(key, { turnId: 't' }, reqAad('POST', '/agent/abort'));
    const tampered: Envelope = { n: good.n, ct: bytesToB64url(b64urlToBytes(good.ct).map((b, i) => (i === 0 ? b ^ 0xff : b))) };
    const tamperedReply = await request(port, 'POST', '/agent/abort', { deviceId, json: tampered });
    check('a tampered envelope → 401', tamperedReply.status === 401);

    // /pair with a code that was never issued → 403.
    const badCode = await request(port, 'POST', '/pair', {
      json: { code: 'ZZZZZZZZ', phPub: bytesToB64url(new Uint8Array(32)), deviceName: 'x', proof: { n: 'AA', ct: 'AA' } },
    });
    check('POST /pair with an unknown code → 403', badCode.status === 403);

    // Bearer path still works alongside the E2E path.
    const bearerSnap = await request(port, 'GET', '/agent/snapshot', { token: TOKEN });
    check('bearer GET /agent/snapshot still → 200 (cleartext)', bearerSnap.status === 200);
    check('bearer snapshot is cleartext JSON', (JSON.parse(bearerSnap.body) as AgentChatState).status === 'idle');
    const noAuth = await request(port, 'GET', '/agent/snapshot');
    check('no auth at all → 401', noAuth.status === 401);

    // CORS: the WebView preflights cross-origin; OPTIONS → 204 + allow-origin, and
    // normal responses carry the header so the browser doesn't block them.
    const preflight = await request(port, 'OPTIONS', '/agent/send');
    check(
      'OPTIONS preflight → 204 with Access-Control-Allow-Origin',
      preflight.status === 204 && preflight.headers['access-control-allow-origin'] === '*',
    );
    check(
      'a normal response carries the CORS allow-origin header',
      bearerSnap.headers['access-control-allow-origin'] === '*',
    );

    // ── L-1: a remote (bridge) peer can't self-approve a gated tool while exposed
    //    (docs/t2-secure-pairing-design.md §8). The desktop approves over IPC
    //    straight into the loop; ONLY the bridge goes through dispatch, which is
    //    where the guard lives. Drive the encrypted /agent/approve against our
    //    paired device, toggling the injected exposure + parked-tool facts. ──────
    const approveEnv = async (
      turnId: string,
      callId: string,
      approved: boolean,
    ): Promise<Reply> =>
      request(port, 'POST', '/agent/approve', {
        deviceId,
        json: await seal(key, { turnId, callId, approved }, reqAad('POST', '/agent/approve')),
      });

    // Server exposed + a GATED tool parked → a remote APPROVE is refused and never
    // reaches the loop; the desktop must confirm it.
    approval.setExposed(true);
    approval.setPending({ turnId: 'turn-gate', callId: 'call-gate', name: 'eval_js' });
    const remoteApprove = await approveEnv('turn-gate', 'call-gate', true);
    check('E2E approve(true) of a gated tool while exposed → 400 (desktop-pinned)', remoteApprove.status === 400);
    check('the refusal returns an explanatory error (cleartext)', /desktop/i.test(remoteApprove.body));
    check('the refused approve did NOT reach the loop.approveTool', approval.calls.length === 0);

    // A remote DENY is still honored (fail-safe — a phone can still CANCEL a tool).
    const remoteDeny = await approveEnv('turn-gate', 'call-gate', false);
    check('E2E deny(false) of a gated tool while exposed → 200 (deny allowed)', remoteDeny.status === 200);
    const denyResult = (await open(key, JSON.parse(remoteDeny.body) as Envelope, resAad('/agent/approve'))) as { ok: boolean };
    check(
      'the deny dispatched to approveTool(approved=false)',
      denyResult.ok === true && approval.calls.length === 1 && approval.calls.every((c) => c.approved === false),
    );

    // The bearer (loopback companion) path is ALSO bridge-originated → same pinning.
    approval.setPending({ turnId: 'turn-gate2', callId: 'call-gate2', name: 'eval_js' });
    const bearerApprove = await request(port, 'POST', '/agent/approve', {
      token: TOKEN,
      json: { turnId: 'turn-gate2', callId: 'call-gate2', approved: true },
    });
    check('bearer approve(true) of a gated tool while exposed → 400 (also desktop-pinned)', bearerApprove.status === 400);
    check('the bearer refusal also did NOT reach approveTool', approval.calls.length === 1);

    // Server OFF ⇒ the desktop-only flow is unchanged: the guard doesn't interfere.
    approval.setExposed(false);
    const approveOff = await approveEnv('turn-gate2', 'call-gate2', true);
    check('E2E approve(true) of a gated tool while NOT exposed → 200 (unchanged)', approveOff.status === 200);
    check(
      'with the server off the approve reached approveTool(approved=true)',
      approval.calls.length === 2 && approval.calls.filter((c) => c.approved).length === 1,
    );

    // The gate is tool-scoped: a NON-gated parked tool is never pinned.
    approval.setExposed(true);
    approval.setPending({ turnId: 'turn-open', callId: 'call-open', name: 'read_file' });
    const approveOpen = await approveEnv('turn-open', 'call-open', true);
    check('E2E approve(true) of a NON-gated tool while exposed → 200 (not pinned)', approveOpen.status === 200);
    check(
      'the non-gated approve reached approveTool',
      approval.calls.length === 3 && approval.calls.filter((c) => c.approved).length === 2,
    );

    // ── rejected approval → 403 (separate server with reject policy) ────────────
    const { deps: depsReject, pairing: pairingReject } = buildDeps({ mode: 'reject' });
    const serverReject = http.createServer((req, res) => void handleRequest(req, res, depsReject));
    await new Promise<void>((r) => serverReject.listen(0, '127.0.0.1', r));
    const rejectPort = (serverReject.address() as AddressInfo).port;
    try {
      const rejected = await pairPhone(rejectPort, pairingReject, 'Denied Phone');
      check('a rejected pairing → 403 (no device minted)', rejected.status === 403);
    } finally {
      serverReject.close();
    }

    // ── unattended (skipApprovals): auto-approve pairing with NO desktop card ────
    const { deps: depsAuto, pairing: pairingAuto, cardShown } = buildDeps({ mode: 'auto' });
    const serverAuto = http.createServer((req, res) => void handleRequest(req, res, depsAuto));
    await new Promise<void>((r) => serverAuto.listen(0, '127.0.0.1', r));
    const autoPort = (serverAuto.address() as AddressInfo).port;
    try {
      const autoPaired = await pairPhone(autoPort, pairingAuto, 'Unattended Phone');
      check(
        'unattended auto-approves pairing → 200 + deviceId',
        autoPaired.status === 200 && typeof autoPaired.deviceId === 'string',
      );
      check('unattended pairing showed NO approval card', !cardShown());
    } finally {
      serverAuto.close();
    }

    console.log(`\npairing + E2E harness: ${passed} assertions passed`);
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error('pairing + E2E harness FAILED:', err);
  process.exitCode = 1;
});
