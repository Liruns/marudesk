import assert from 'node:assert/strict';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { WebSocket } from 'ws';
import type { Account, AccountMethod, AccountStore } from '../src/accounts/store.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { createServer, type RelayServer } from '../src/server.ts';
import { __resetRefreshState } from '../src/auth/service.ts';
import { exchangeForIdentity } from '../src/oauth/providers.ts';
import type { OAuthProviderConfig } from '../src/config.ts';

/**
 * Headless integration harness for the relay (Bridge Model B, B1). Mirrors the
 * marudesk repo's harness style (run with `node --experimental-strip-types`, see
 * package.json `test`): boots the REAL server on an ephemeral port with an
 * in-memory account store (hermetic — touches no relay-data/), then drives the
 * full surface and tears everything down in a finally block (no orphan
 * listeners/sockets/processes).
 *
 * Asserts: signup→login→JWT; /me with vs without a token; same-account WS
 * brokering BOTH directions (client→host AND host→client); cross-account
 * isolation (a different account's client is NOT brokered to account A's host);
 * bad/missing token rejected on BOTH HTTP and WS; refresh rotation (new pair
 * works, the rotated-out refresh is rejected).
 *
 * Plus the B1 security-review fixes: multi-device refresh (two simultaneous
 * sessions on one account each keep a working refresh — neither evicts the other);
 * one-time-use refresh (a consumed/rotated jti is rejected on replay); per-session
 * logout (POST /auth/logout kills one session's refresh while another still works);
 * the WS upgrade rejects a disallowed Origin; and Google OAuth refuses an identity
 * whose email is not verified (provider exchange mocked via a stubbed fetch).
 */

/* ── In-memory AccountStore (keeps the harness hermetic) ──────────────────── */
class MemoryStore implements AccountStore {
  private readonly byId = new Map<string, Account>();
  async findByEmail(email: string): Promise<Account | null> {
    const key = email.toLowerCase();
    for (const a of this.byId.values()) if (a.email.toLowerCase() === key) return a;
    return null;
  }
  async findById(id: string): Promise<Account | null> {
    return this.byId.get(id) ?? null;
  }
  async findByProvider(method: AccountMethod, providerSub: string): Promise<Account | null> {
    for (const a of this.byId.values()) if (a.method === method && a.providerSub === providerSub) return a;
    return null;
  }
  async create(account: Account): Promise<Account> {
    if (await this.findByEmail(account.email)) throw new Error('email already registered');
    this.byId.set(account.id, account);
    return account;
  }
  async update(account: Account): Promise<Account> {
    if (!this.byId.has(account.id)) throw new Error('account not found');
    this.byId.set(account.id, account);
    return account;
  }
}

/* ── HTTP helper ──────────────────────────────────────────────────────────── */
type Reply = { status: number; json: unknown; headers: IncomingHttpHeaders };

function http(
  port: number,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; contentType?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = {};
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (payload !== undefined) {
      headers['content-type'] = opts.contentType ?? 'application/json';
      headers['content-length'] = String(Buffer.byteLength(payload));
    }
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown = null;
        try {
          json = text.length ? JSON.parse(text) : null;
        } catch {
          json = text;
        }
        resolve({ status: res.statusCode ?? 0, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/* ── WS helpers ───────────────────────────────────────────────────────────── */
/** Open a relay WS; resolve on 'open', reject on error/unexpected-response (e.g. 401). */
function wsConnect(port: number, role: 'host' | 'client', token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/connect?role=${role}&token=${encodeURIComponent(token)}`);
    const onError = (err: Error): void => reject(err);
    ws.once('error', onError);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`ws rejected: ${res.statusCode}`)));
    ws.once('open', () => {
      ws.off('error', onError);
      resolve(ws);
    });
  });
}

/**
 * Attempt a WS upgrade that we EXPECT to be rejected (e.g. bad Origin / bad token);
 * resolves true if the server refused the handshake, false if it unexpectedly opened.
 * `headers` lets a test send an Origin the `ws` client wouldn't otherwise set.
 */
function wsExpectReject(
  port: number,
  role: 'host' | 'client',
  token: string,
  headers: Record<string, string> = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/connect?role=${role}&token=${encodeURIComponent(token)}`,
      { headers },
    );
    ws.once('open', () => {
      ws.close();
      resolve(false); // should NOT have opened
    });
    ws.once('error', () => resolve(true));
    ws.once('unexpected-response', () => resolve(true));
  });
}

/** Wait for the next *relay* frame (skips the initial `ready`/heartbeat frames). */
function nextRelayFrame(ws: WebSocket, timeoutMs = 3000): Promise<{ from: string; payload: unknown }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error('timed out waiting for a relay frame'));
    }, timeoutMs);
    timer.unref();
    const onMsg = (data: Buffer): void => {
      let frame: { type?: string; from?: string; payload?: unknown };
      try {
        frame = JSON.parse(data.toString('utf8')) as typeof frame;
      } catch {
        return;
      }
      if (frame.type !== 'relay') return; // ignore 'ready' etc.
      clearTimeout(timer);
      ws.off('message', onMsg);
      resolve({ from: String(frame.from), payload: frame.payload });
    };
    ws.on('message', onMsg);
  });
}

/** Assert NO relay frame arrives within `windowMs` (used for cross-account isolation). */
function expectNoRelayFrame(ws: WebSocket, windowMs = 600): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMsg = (data: Buffer): void => {
      try {
        const frame = JSON.parse(data.toString('utf8')) as { type?: string };
        if (frame.type === 'relay') {
          ws.off('message', onMsg);
          reject(new Error('a relay frame leaked across accounts'));
        }
      } catch {
        /* ignore */
      }
    };
    ws.on('message', onMsg);
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      resolve();
    }, windowMs);
    timer.unref();
  });
}

function closeAll(...sockets: WebSocket[]): Promise<void> {
  return Promise.all(
    sockets.map(
      (ws) =>
        new Promise<void>((resolve) => {
          if (ws.readyState === ws.CLOSED) return resolve();
          ws.once('close', () => resolve());
          ws.close();
        }),
    ),
  ).then(() => undefined);
}

/* ── Main ─────────────────────────────────────────────────────────────────── */
async function main(): Promise<void> {
  __resetRefreshState();
  // Ephemeral port (PORT=0), fixed secret so tokens are deterministic, in-mem store.
  process.env.PORT = '0';
  process.env.HOST = '127.0.0.1';
  process.env.JWT_SECRET = 'harness-fixed-secret-value-1234567890';
  // Raise the auth burst so this single-client scripted run exercises auth
  // CORRECTNESS without tripping the per-IP limiter; a dedicated case below
  // verifies the limiter itself with a tight budget.
  process.env.AUTH_RATE_BURST = '1000';
  const config: Config = loadConfig();
  const server: RelayServer = createServer({ config, store: new MemoryStore() });
  const port = await server.listen();

  let passed = 0;
  const check = (label: string, cond: boolean): void => {
    assert.ok(cond, label);
    passed += 1;
    console.log(`  ok ${passed} - ${label}`);
  };

  const openSockets: WebSocket[] = [];
  try {
    // ── health is unauthenticated ──────────────────────────────────────────
    const health = await http(port, 'GET', '/health');
    check('GET /health → 200 {ok,name}', health.status === 200 && (health.json as { ok?: boolean }).ok === true);

    // ── OAuth is "not configured" in dev (no client id/secret) → 503, not a crash ──
    const gAuth = await http(port, 'GET', '/auth/google');
    check('GET /auth/google without creds → 503 (OAuth not configured)', gAuth.status === 503);
    const ghCb = await http(port, 'GET', '/auth/github/callback?code=x&state=y');
    check('GET /auth/github/callback without creds → 503', ghCb.status === 503);

    // ── signup (account A) ─────────────────────────────────────────────────
    const signupA = await http(port, 'POST', '/auth/signup', {
      body: { email: 'alice@example.com', password: 'correct-horse-battery' },
    });
    check('POST /auth/signup → 201', signupA.status === 201);
    const aTokens = signupA.json as { accountId?: string; accessToken: string; refreshToken: string; account: { id: string; email: string } };
    check('signup returns an access + refresh token', !!aTokens.accessToken && !!aTokens.refreshToken);
    check('signup returns the public account (no secrets)', aTokens.account.email === 'alice@example.com' && !('passwordHash' in (aTokens.account as object)));
    const accountAId = aTokens.account.id;

    // duplicate signup is rejected
    const dup = await http(port, 'POST', '/auth/signup', { body: { email: 'alice@example.com', password: 'another-password' } });
    check('duplicate signup → 409', dup.status === 409);

    // weak password / bad email rejected (input validation)
    const weak = await http(port, 'POST', '/auth/signup', { body: { email: 'b@example.com', password: 'short' } });
    check('signup with a too-short password → 400', weak.status === 400);
    const badEmail = await http(port, 'POST', '/auth/signup', { body: { email: 'not-an-email', password: 'correct-horse-battery' } });
    check('signup with a bad email → 400', badEmail.status === 400);

    // ── login (account A) ──────────────────────────────────────────────────
    const loginA = await http(port, 'POST', '/auth/login', { body: { email: 'alice@example.com', password: 'correct-horse-battery' } });
    check('POST /auth/login → 200 with tokens', loginA.status === 200 && !!(loginA.json as { accessToken?: string }).accessToken);
    const accessA = (loginA.json as { accessToken: string }).accessToken;
    const refreshA = (loginA.json as { refreshToken: string }).refreshToken;

    // wrong password → generic 401 (no enumeration: same status/shape as unknown user)
    const wrongPw = await http(port, 'POST', '/auth/login', { body: { email: 'alice@example.com', password: 'WRONG-password' } });
    const unknownUser = await http(port, 'POST', '/auth/login', { body: { email: 'nobody@example.com', password: 'whatever-password' } });
    check('login wrong password → 401', wrongPw.status === 401);
    check('login unknown user → 401 (same generic error, no enumeration)', unknownUser.status === 401 && JSON.stringify(unknownUser.json) === JSON.stringify(wrongPw.json));

    // ── /me requires a valid bearer token ──────────────────────────────────
    const meOk = await http(port, 'GET', '/me', { token: accessA });
    check('GET /me with the token → 200 + the account', meOk.status === 200 && (meOk.json as { account: { id: string } }).account.id === accountAId);
    const meNoTok = await http(port, 'GET', '/me');
    check('GET /me without a token → 401', meNoTok.status === 401);
    const meBadTok = await http(port, 'GET', '/me', { token: 'not.a.jwt' });
    check('GET /me with a bad token → 401', meBadTok.status === 401);

    // ── account B (a DIFFERENT account) ────────────────────────────────────
    const signupB = await http(port, 'POST', '/auth/signup', { body: { email: 'bob@example.com', password: 'a-different-password' } });
    check('signup account B → 201', signupB.status === 201);
    const accessB = (signupB.json as { accessToken: string }).accessToken;

    // ── WS: bad/missing token rejected on the upgrade ──────────────────────
    let wsBadRejected = false;
    try {
      const bad = await wsConnect(port, 'host', 'garbage-token');
      openSockets.push(bad);
    } catch {
      wsBadRejected = true;
    }
    check('WS /connect with a bad token is rejected', wsBadRejected);

    let wsNoRoleRejected = false;
    try {
      // valid token but no role → rejected
      const ws = new WebSocket(`ws://127.0.0.1:${port}/connect?token=${encodeURIComponent(accessA)}`);
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => {
          openSockets.push(ws);
          reject(new Error('opened without a role'));
        });
        ws.once('error', () => resolve());
        ws.once('unexpected-response', () => resolve());
      });
      wsNoRoleRejected = true;
    } catch {
      wsNoRoleRejected = false;
    }
    check('WS /connect without a role is rejected', wsNoRoleRejected);

    // ── WS: same-account brokering, BOTH directions ────────────────────────
    const hostA = await wsConnect(port, 'host', accessA);
    const clientA = await wsConnect(port, 'client', accessA);
    openSockets.push(hostA, clientA);

    // client → host
    const hostRecv = nextRelayFrame(hostA);
    clientA.send(JSON.stringify({ payload: { kind: 'agent/send', prompt: 'hello host' } }));
    const fromClient = await hostRecv;
    check(
      'client→host: host receives the forwarded payload (from:client)',
      fromClient.from === 'client' && (fromClient.payload as { prompt?: string }).prompt === 'hello host',
    );

    // host → client
    const clientRecv = nextRelayFrame(clientA);
    hostA.send(JSON.stringify({ payload: { kind: 'agent:event', status: 'streaming' } }));
    const fromHost = await clientRecv;
    check(
      'host→client: client receives the forwarded payload (from:host)',
      fromHost.from === 'host' && (fromHost.payload as { status?: string }).status === 'streaming',
    );

    // ── WS: cross-account isolation ────────────────────────────────────────
    const clientB = await wsConnect(port, 'client', accessB);
    openSockets.push(clientB);
    const noLeak = expectNoRelayFrame(hostA, 700);
    clientB.send(JSON.stringify({ payload: { kind: 'agent/send', prompt: 'should NOT reach A host' } }));
    await noLeak;
    check("account B's client message is NOT brokered to account A's host", true);

    // ── refresh rotation ───────────────────────────────────────────────────
    const refreshed = await http(port, 'POST', '/auth/refresh', { body: { refreshToken: refreshA } });
    check('POST /auth/refresh → 200 with a new pair', refreshed.status === 200 && !!(refreshed.json as { accessToken?: string }).accessToken);
    const newRefresh = (refreshed.json as { refreshToken: string }).refreshToken;
    check('refresh issues a NEW refresh token (rotated)', newRefresh !== refreshA);

    // the rotated-OUT (old) refresh token is now rejected
    const reuseOld = await http(port, 'POST', '/auth/refresh', { body: { refreshToken: refreshA } });
    check('the old (rotated-out) refresh token → 401', reuseOld.status === 401);

    // the new refresh token still works (and rotates again)
    const refreshAgain = await http(port, 'POST', '/auth/refresh', { body: { refreshToken: newRefresh } });
    check('the new refresh token works → 200', refreshAgain.status === 200);

    // a bogus refresh token is rejected
    const badRefresh = await http(port, 'POST', '/auth/refresh', { body: { refreshToken: 'nope.nope.nope' } });
    check('a malformed refresh token → 401', badRefresh.status === 401);

    // ── H1: multi-device — two simultaneous sessions on ONE account ─────────
    // Model B runs PC host + phone client on the same account; logging in on one
    // must NOT invalidate the other's refresh token.
    const dev1 = await http(port, 'POST', '/auth/login', { body: { email: 'alice@example.com', password: 'correct-horse-battery' } });
    const dev2 = await http(port, 'POST', '/auth/login', { body: { email: 'alice@example.com', password: 'correct-horse-battery' } });
    const dev1Refresh = (dev1.json as { refreshToken: string }).refreshToken;
    const dev2Refresh = (dev2.json as { refreshToken: string }).refreshToken;
    check('two logins for one account issue DISTINCT refresh tokens', dev1Refresh !== dev2Refresh);
    // Refreshing device 1 must leave device 2's refresh fully usable (no eviction).
    const dev1Refreshed = await http(port, 'POST', '/auth/refresh', { body: { refreshToken: dev1Refresh } });
    check('device 1 refresh works → 200 (multi-device)', dev1Refreshed.status === 200);
    const dev2Refreshed = await http(port, 'POST', '/auth/refresh', { body: { refreshToken: dev2Refresh } });
    check("device 2's refresh STILL works after device 1 rotated → 200 (no eviction)", dev2Refreshed.status === 200);

    // ── H1: one-time use — a consumed (already-rotated) jti is rejected ─────
    const otuLogin = await http(port, 'POST', '/auth/login', { body: { email: 'alice@example.com', password: 'correct-horse-battery' } });
    const otuRefresh = (otuLogin.json as { refreshToken: string }).refreshToken;
    const otuFirst = await http(port, 'POST', '/auth/refresh', { body: { refreshToken: otuRefresh } });
    check('first use of a refresh token works → 200', otuFirst.status === 200);
    const otuReplay = await http(port, 'POST', '/auth/refresh', { body: { refreshToken: otuRefresh } });
    check('replay of the SAME (now-consumed) refresh jti → 401 (one-time use)', otuReplay.status === 401);

    // ── M1: POST /auth/logout invalidates one session, others survive ───────
    const loA = await http(port, 'POST', '/auth/login', { body: { email: 'alice@example.com', password: 'correct-horse-battery' } });
    const loB = await http(port, 'POST', '/auth/login', { body: { email: 'alice@example.com', password: 'correct-horse-battery' } });
    const loAAccess = (loA.json as { accessToken: string }).accessToken;
    const loARefresh = (loA.json as { refreshToken: string }).refreshToken;
    const loBRefresh = (loB.json as { refreshToken: string }).refreshToken;
    const logoutRes = await http(port, 'POST', '/auth/logout', { token: loAAccess, body: { refreshToken: loARefresh } });
    check('POST /auth/logout → 200 {ok}', logoutRes.status === 200 && (logoutRes.json as { ok?: boolean }).ok === true);
    const loAAfter = await http(port, 'POST', '/auth/refresh', { body: { refreshToken: loARefresh } });
    check('the logged-out session\'s refresh → 401', loAAfter.status === 401);
    const loBAfter = await http(port, 'POST', '/auth/refresh', { body: { refreshToken: loBRefresh } });
    check('a DIFFERENT session\'s refresh still works after logout → 200', loBAfter.status === 200);
    const logoutBad = await http(port, 'POST', '/auth/logout', { body: {} });
    check('POST /auth/logout without a refreshToken → 400', logoutBad.status === 400);

    // ── M6: the WS upgrade rejects a disallowed Origin (cross-site WS) ──────
    const evilOrigin = await wsExpectReject(port, 'host', accessA, { origin: 'https://evil.example.com' });
    check('WS /connect with a disallowed Origin is rejected', evilOrigin);
    // sanity: a valid token with NO Origin (native client) still connects
    const noOriginOk = await wsConnect(port, 'host', accessA);
    openSockets.push(noOriginOk);
    check('WS /connect with no Origin (native client) still connects', noOriginOk.readyState === noOriginOk.OPEN);

    // ── M2: Google identity without email_verified:true is refused ─────────
    // Mock the provider exchange (token endpoint + userinfo) so this stays hermetic.
    const realFetch = globalThis.fetch;
    const googleCfg: OAuthProviderConfig = {
      clientId: 'test-client',
      clientSecret: 'test-secret',
      redirectUri: 'http://localhost/auth/google/callback',
    };
    const mockGoogle = (verified: boolean | undefined): typeof globalThis.fetch =>
      (async (input: string | URL | Request): Promise<Response> => {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (u.includes('/token')) {
          return new Response(JSON.stringify({ access_token: 'mock-access' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        // userinfo
        const body: Record<string, unknown> = { sub: 'g-123', email: 'mallory@example.com', name: 'Mallory' };
        if (verified !== undefined) body.email_verified = verified;
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof globalThis.fetch;
    try {
      globalThis.fetch = mockGoogle(false);
      let unverifiedRejected = false;
      try {
        await exchangeForIdentity('google', googleCfg, 'mock-code');
      } catch {
        unverifiedRejected = true;
      }
      check('Google identity with email_verified:false is refused', unverifiedRejected);

      globalThis.fetch = mockGoogle(undefined);
      let missingRejected = false;
      try {
        await exchangeForIdentity('google', googleCfg, 'mock-code');
      } catch {
        missingRejected = true;
      }
      check('Google identity with email_verified absent is refused', missingRejected);

      globalThis.fetch = mockGoogle(true);
      const verifiedIdentity = await exchangeForIdentity('google', googleCfg, 'mock-code');
      check(
        'Google identity with email_verified:true is accepted',
        verifiedIdentity.email === 'mallory@example.com' && verifiedIdentity.providerSub === 'g-123',
      );
    } finally {
      globalThis.fetch = realFetch;
    }

    // ── rate limit: a dedicated server with a tight per-IP budget ───────────
    process.env.AUTH_RATE_BURST = '2';
    const rlServer = createServer({ config: loadConfig(), store: new MemoryStore() });
    const rlPort = await rlServer.listen();
    try {
      // 2 allowed by the burst, the 3rd from the same IP is limited.
      const r1 = await http(rlPort, 'POST', '/auth/login', { body: { email: 'x@example.com', password: 'whatever-password' } });
      const r2 = await http(rlPort, 'POST', '/auth/login', { body: { email: 'x@example.com', password: 'whatever-password' } });
      const r3 = await http(rlPort, 'POST', '/auth/login', { body: { email: 'x@example.com', password: 'whatever-password' } });
      check(
        'per-IP auth rate limit kicks in (3rd request over a burst of 2 → 429)',
        r1.status !== 429 && r2.status !== 429 && r3.status === 429,
      );
    } finally {
      await rlServer.close();
    }

    console.log(`\nrelay harness: ${passed} assertions passed`);
  } finally {
    await closeAll(...openSockets);
    await server.close();
  }
}

main().catch((err) => {
  console.error('relay harness FAILED:', err);
  process.exitCode = 1;
});
