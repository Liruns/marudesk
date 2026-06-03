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

## Deploy (public, with automatic HTTPS)

This is the one piece WebRTC P2P can't remove: a public **rendezvous** with a
stable address that introduces the two peers (and carries the rare relay
fallback). You host it **once**; end users install nothing. `docker-compose.yml`
brings up the relay behind a [Caddy](https://caddyserver.com/) sidecar that gets
a Let's Encrypt cert automatically and proxies both the auth API and the
`wss://…/connect` upgrade.

```bash
# 1. Point a DNS A/AAAA record for your domain at the server.
# 2. Configure:
cp .env.deploy.example .env
#    set RELAY_DOMAIN=relay.example.com and JWT_SECRET=$(openssl rand -hex 48)
# 3. Bring it up:
docker compose up -d --build
# 4. Verify (TLS + liveness):
curl https://relay.example.com/health      # → {"ok":true,"name":"marudesk-relay"}
```

Then point the clients at it:

- **PC**: marudesk → Settings → cloud relay, URL `https://relay.example.com`,
  log in (and enable cloud) → the host dials out as `role=host`.
- **Phone**: build the mobile app with `VITE_USE_RELAY=true`, enter the same
  relay URL, log into the same account. It connects as `role=client`, then
  upgrades to a **direct WebRTC P2P** channel where the network allows
  (`../marudesk/docs/webrtc-p2p-design.md`), falling back to this relay otherwise.

Notes:

- **`JWT_SECRET`** must be a stable ≥32-byte secret (the image refuses to boot in
  this `NODE_ENV=production`, non-loopback posture without one). Changing it logs
  everyone out.
- **CORS / WS Origin**: the Electron host sends no Origin (native) and always
  connects; Android Capacitor uses `http(s)://localhost` (already allowed); **iOS**
  WKWebView uses `capacitor://localhost` — add it to `CORS_ORIGINS` (the example
  already does).
- **Persistence**: accounts live in the `relay-data` volume (the dev file store —
  fine for personal/small use; see the caveat below). Keep the `caddy-data` volume
  too so certs survive redeploys.
- **OAuth** (optional): set the provider id/secret + `OAUTH_REDIRECT_BASE=https://
  relay.example.com` and register `https://relay.example.com/auth/<provider>/callback`.

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

## Deferred to deployment (design §4 prerequisites)

- **Hosting** + a **domain** + **TLS** — now provided by `docker-compose.yml` +
  Caddy (see **Deploy** above). Drop it on any VPS / Fly / Render / Railway box.
- Real **Google / GitHub OAuth apps** (client id/secret + registered redirect
  URIs `https://<domain>/auth/<provider>/callback`) — optional; unset ⇒ 503.
- A real **database** behind the `AccountStore` interface (the file store is
  dev/small-scale: whole-file rewrite, single-process — fine for personal use).
- A shared/edge **rate limiter** for multi-instance deployments (the in-memory
  token bucket is per-process).
- Optional **end-to-end encryption** of the forwarded payload (the relay is
  already payload-agnostic, so this is additive).
