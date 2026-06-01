import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import type { Config } from './config.ts';
import { FileAccountStore } from './accounts/file-store.ts';
import type { AccountStore } from './accounts/store.ts';
import { authenticate, type AuthDeps } from './auth/service.ts';
import { RateLimiter } from './auth/rate-limit.ts';
import { allowedOrigin, clientIp, handleRequest, type RouterDeps } from './http/router.ts';
import { RelayHub, type HubSocket, type Role } from './ws/hub.ts';

/**
 * Composition root: wires the pure HTTP router + the `ws` WebSocket broker onto a
 * single `node:http` server. Exposes a {@link RelayServer} with `listen`/`close`
 * so both the entrypoint (./index.ts) and the headless harness drive it the same
 * way — and `close()` tears EVERYTHING down (HTTP, WS, heartbeat) so tests leave
 * no orphan listeners.
 *
 * WS auth (Bridge Model B §1): the `/connect` upgrade is per-IP rate-limited, then
 * (if an Origin is present) checked against the CORS allowlist, then authenticated
 * by a JWT access token from `?token=` or the `Authorization` header — all BEFORE
 * the socket is accepted. The verified account id + the `?role=host|client` query
 * bind the socket in the {@link RelayHub}, which brokers strictly within that account.
 */

const HEARTBEAT_MS = 30_000;
const MAX_WS_MESSAGE_BYTES = 1024 * 1024;

export type RelayServer = {
  http: Server;
  hub: RelayHub;
  /** Start listening; resolves with the bound port. */
  listen(): Promise<number>;
  /** Stop accepting, drop all sockets + timers, close the HTTP server. */
  close(): Promise<void>;
};

export type CreateServerOptions = {
  config: Config;
  /** Override the account store (the harness uses an in-memory one). */
  store?: AccountStore;
};

/** Adapt a `ws` WebSocket to the hub's minimal {@link HubSocket} surface. */
function toHubSocket(ws: WebSocket): HubSocket {
  return {
    sendText(data: string): void {
      if (ws.readyState === ws.OPEN) ws.send(data);
    },
    close(code?: number, reason?: string): void {
      try {
        ws.close(code, reason);
      } catch {
        /* already closing */
      }
    },
  };
}

/** Extract the access token from the upgrade request (`?token=` or Authorization). */
function tokenFromUpgrade(req: IncomingMessage, url: URL): string | null {
  const q = url.searchParams.get('token');
  if (q && q.trim()) return q.trim();
  const header = req.headers.authorization;
  if (typeof header === 'string') {
    const m = /^Bearer\s+(\S.*)$/i.exec(header);
    if (m) return m[1]!.trim();
  }
  return null;
}

function roleFromUpgrade(url: URL): Role | null {
  const r = url.searchParams.get('role');
  return r === 'host' || r === 'client' ? r : null;
}

export function createServer(opts: CreateServerOptions): RelayServer {
  const { config } = opts;
  const store = opts.store ?? new FileAccountStore(config.dataDir);

  const auth: AuthDeps = {
    store,
    secret: config.jwtSecret,
    accessTtlSec: config.accessTtlSec,
    refreshTtlSec: config.refreshTtlSec,
  };
  const rateLimiter = new RateLimiter(config.authRateBurst, config.authRateRefillPerSec);
  const routerDeps: RouterDeps = { config, auth, rateLimiter };
  const hub = new RelayHub({ maxMessageBytes: MAX_WS_MESSAGE_BYTES });

  const http = createHttpServer((req, res) => {
    void handleRequest(req, res, routerDeps).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end('{"error":"internal error"}');
      }
    });
  });

  // `noServer` so we authenticate the upgrade ourselves before accepting.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_MESSAGE_BYTES });

  // Liveness-bound liveness flag per socket for the heartbeat sweep.
  const alive = new WeakMap<WebSocket, boolean>();

  http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/connect') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    // Per-IP rate limit the upgrade BEFORE any auth work (same limiter as the HTTP
    // auth routes), so a flood of upgrade attempts can't bypass it / burn CPU.
    if (!rateLimiter.take(clientIp(req))) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      socket.destroy();
      return;
    }
    // Defense-in-depth vs cross-site WebSocket hijacking: if the handshake carries
    // an Origin (browsers always do), require it to pass the SAME allowlist as CORS.
    // A missing Origin (native/non-browser client) is allowed — the JWT still gates.
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigin(origin, config)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const token = tokenFromUpgrade(req, url);
    const role = roleFromUpgrade(url);
    if (!token || !role) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    // Verify the JWT + load the account BEFORE completing the handshake.
    authenticate(auth, token).then(
      (account) => {
        wss.handleUpgrade(req, socket, head, (ws) => {
          bindSocket(ws, account.id, role);
        });
      },
      () => {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
      },
    );
  });

  function bindSocket(ws: WebSocket, accountId: string, role: Role): void {
    const hubSocket = toHubSocket(ws);
    hub.register(accountId, role, hubSocket);
    alive.set(ws, true);

    // Tell the freshly-connected peer who/what it is + current peer counts.
    hubSocket.sendText(JSON.stringify({ type: 'ready', role, accountId, peers: hub.counts(accountId) }));

    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      // We only broker UTF-8 text frames; binary is out of scope for the dumb pipe.
      if (isBinary) return;
      const raw = Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : Buffer.from(data as Buffer).toString('utf8');
      hub.route(accountId, role, hubSocket, raw);
    });
    ws.on('pong', () => alive.set(ws, true));
    ws.on('close', () => {
      hub.unregister(accountId, role, hubSocket);
      alive.delete(ws);
    });
    ws.on('error', () => {
      hub.unregister(accountId, role, hubSocket);
      alive.delete(ws);
    });
  }

  // Heartbeat: ping each socket; drop ones that didn't pong since last sweep.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      try {
        ws.ping();
      } catch {
        /* socket gone */
      }
    }
    rateLimiter.sweep();
  }, HEARTBEAT_MS);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  return {
    http,
    hub,
    listen(): Promise<number> {
      return new Promise<number>((resolve, reject) => {
        http.once('error', reject);
        http.listen(config.port, config.host, () => {
          http.off('error', reject);
          resolve((http.address() as AddressInfo).port);
        });
      });
    },
    close(): Promise<void> {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      return new Promise<void>((resolve) => {
        wss.close(() => {
          http.close(() => resolve());
        });
      });
    },
  };
}
