# marudesk-relay

Cloud relay + auth backend for marudesk — the "Bridge Model B" core (see
`../marudesk/docs/bridge-model-b-design.md`, stage **B1**).

A standalone Node service that lets a marudesk **PC (host)** and a **phone
(client)** — both connecting *outbound* — talk through the cloud, brokered **only
when they are the same logged-in account**. This solves "works anywhere, no
port-forwarding": both peers dial out to the relay, which is a payload-agnostic
**dumb pipe** plus an account/JWT/OAuth service. Agent logic, credentials,
workspace and CDP all stay on the PC; the relay never parses or stores the
forwarded payload (room for future end-to-end encryption).

## Stack

Node (ESM, TypeScript, strict) + [`ws`](https://github.com/websockets/ws) for
WebSocket + node built-ins (`http`, `crypto`). No Express, no DB lib. Run with
Node's native TS stripping (`node --experimental-strip-types`).

## Run locally (no hosting / OAuth apps needed)

```bash
npm install
npm start          # boots on PORT (default 8788); binds HOST (default 0.0.0.0)
```

For dev you can leave **everything** unset:

- `JWT_SECRET` unset → an **ephemeral** signing secret is generated per boot
  (logs a clear warning; all tokens invalidate on restart). Set it for anything
  persistent.
- OAuth client id/secret unset → `/auth/{google,github}[/callback]` return **503
  "OAuth not configured"** instead of crashing. Local email+password auth and the
  WS relay work fully without them.

Copy `.env.example` → `.env` to configure. A relay binds `0.0.0.0` by design
(it's meant to be reachable); for strictly-local dev set `HOST=127.0.0.1`.

## Verify

```bash
npm run typecheck   # tsc --noEmit (strict) → 0 errors
npm test            # headless integration harness → 27 assertions
```

The harness boots the real server on an ephemeral port with an in-memory account
store (hermetic — writes no `relay-data/`), exercises signup→login→JWT, `/me`
with/without a token, **same-account WS brokering in both directions**,
**cross-account isolation**, bad/missing-token rejection on HTTP **and** WS,
refresh rotation (old token rejected), the OAuth 503 path, and the per-IP rate
limit — then tears down every server + socket (no orphan listeners).

## HTTP surface (JSON, body-capped, input-validated)

| Method + path | Auth | Body | Result |
|---|---|---|---|
| `POST /auth/signup` | rate-limited | `{email,password}` | `201 {account, accessToken, refreshToken, expiresInSec}` |
| `POST /auth/login` | rate-limited | `{email,password}` | `200 {account, ...tokens}` (generic 401 on failure — no user enumeration) |
| `POST /auth/refresh` | rate-limited | `{refreshToken}` | `200 {...rotated tokens}` (old refresh becomes invalid) |
| `GET /me` | `Bearer <accessToken>` | — | `200 {account}` (no secrets) / `401` |
| `GET /auth/{google,github}` | rate-limited | — | `302` to provider, or `503` if not configured |
| `GET /auth/{google,github}/callback` | rate-limited | `?code&state` | `200 {account, ...tokens}`, or `503` if not configured |
| `GET /health` | none | — | `200 {ok,name}` (liveness) |

## WebSocket surface

```
ws://<relay>/connect?role=host|client&token=<accessToken>
```

The upgrade is **JWT-authenticated before acceptance** (`?token=` or
`Authorization: Bearer`); the verified account id + `role` bind the socket. The
relay keeps `Map<accountId, {hosts, clients}>` and forwards an opaque envelope
`{ type:'relay', from:'host'|'client', payload }`:

- a **client**'s message → that account's **host(s)**;
- a **host**'s message → that account's **client(s)**;
- **never** across accounts.

On connect a peer first receives `{ type:'ready', role, accountId, peers }`.
Heartbeat ping/pong drops dead sockets; messages are size-capped; maps are pruned
on close.

## How same-account brokering + auth are enforced

- The signing secret lives only on the server; tokens are HS256 JWTs
  (`alg:none`/alg-swap rejected, signature compared constant-time, `exp`
  enforced). Refresh tokens carry a `jti` and **rotate** — the previous one is
  recorded and a replayed/rotated-out refresh is rejected.
- Passwords are hashed with `crypto.scrypt` + a per-user random salt; verification
  is a constant-time compare. Plaintext is never stored, returned, or logged.
  Login runs a dummy scrypt verify on unknown emails so timing doesn't leak
  existence, and both failure modes return one generic error.
- The WS hub routes strictly within one `accountId`; there is no code path that
  forwards between buckets.

## Architecture (files)

```
src/
  config.ts            env → Config (ephemeral-secret warning, OAuth on/off, rate-limit knobs)
  index.ts             entrypoint: load config, boot, log surface, graceful shutdown
  server.ts            composition root: HTTP router + ws broker on one http.Server; listen/close
  http/router.ts       pure DI'd HTTP handler (auth API + CORS + body caps + rate-limit)
  ws/hub.ts            payload-agnostic same-account broker (transport-agnostic)
  auth/
    service.ts         signup/login/refresh/authenticate + OAuth identity → account
    dummy.ts           constant-time dummy verify for unknown-user logins
    rate-limit.ts      per-IP token bucket
  accounts/
    store.ts           Account model + AccountStore interface + public projection
    file-store.ts      dev JSON store (atomic writes, serialized mutations)
  crypto/
    jwt.ts             HS256 sign/verify (no lib)
    password.ts        scrypt hash/verify
    safe.ts            length-guarded constant-time compare
oauth/ is under src/oauth/providers.ts (Google/GitHub web flow + CSRF state)
test/harness.ts        headless integration harness (npm test)
```

## Deferred to deployment (design §4 prerequisites — expected)

- **Hosting** (VPS / Fly / Render / Railway / Cloudflare) + a **domain** for the
  OAuth redirect and **TLS**.
- Real **Google / GitHub OAuth apps** (client id/secret + registered redirect
  URIs `https://<domain>/auth/<provider>/callback`).
- A real **database** behind the `AccountStore` interface (the file store is
  dev-only: whole-file rewrite, single-process).
- A shared/edge **rate limiter** for multi-instance deployments (the in-memory
  token bucket is per-process).
- Optional **end-to-end encryption** of the forwarded payload (the relay is
  already payload-agnostic, so this is additive).
