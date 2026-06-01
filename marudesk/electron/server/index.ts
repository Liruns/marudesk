import http from 'node:http';
import type { Socket } from 'node:net';
import { app } from 'electron';
import type { AppSettings } from '../../shared/settings';
import {
  abortTurn,
  approveTool,
  reset,
  respond,
  snapshot,
  startTurn,
  subscribeAgentEvents,
} from '../agent/loop';
import { getConnectCandidates } from './pairing-urls';
import { handleRequest, type RouterDeps } from './router';
import { getServerToken } from './token';

/**
 * Lifecycle for the PC-side headless bridge server (docs/remote-mobile-bridge-design
 * §M4). The server runs IN the Electron main process and calls the agent loop's
 * exported functions DIRECTLY (no IPC), relaying state to a future companion app
 * over SSE + REST.
 *
 * Security invariants (also enforced in ./router.ts):
 * - Binds 0.0.0.0 (all interfaces) so a phone on the LAN or Tailscale can reach
 *   it (T2 — docs/remote-mobile-bridge-design §3). Exposure is gated by: OFF by
 *   default, a required bearer token, and a Settings warning. App-level E2E
 *   encryption + device pairing are later T2 phases; until then prefer Tailscale
 *   (WireGuard-encrypted) over an untrusted public LAN.
 * - OFF by default — only listens when settings.server.enabled is true.
 * - Every request requires a bearer token (constant-time checked in the router).
 */

const HOST = '0.0.0.0';

let server: http.Server | null = null;
/** The port we're currently listening on (so a port change restarts the server). */
let boundPort: number | null = null;
/** Guards against overlapping start/stop while an async start is in flight. */
let transitioning = false;
// Track live sockets so stop() doesn't hang on keep-alive / open SSE connections.
const sockets = new Set<Socket>();

/** Whether the bridge server is currently listening. */
export function isServerRunning(): boolean {
  return server !== null;
}

/** Start the bridge server on `port` (127.0.0.1). No-op if already running. */
export async function startServer(port: number): Promise<void> {
  if (server) return;
  // Resolve the bearer token up front (mints + persists one on first need) so a
  // request can never race an unset token.
  const token = await getServerToken();
  const deps: RouterDeps = {
    token,
    version: app.getVersion(),
    agent: { startTurn, abortTurn, respond, approveTool, snapshot, reset },
    subscribe: subscribeAgentEvents,
  };

  const srv = http.createServer((req, res) => {
    // Never let a handler rejection crash the process; surface a 500 instead.
    void handleRequest(req, res, deps).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      }
      if (!res.writableEnded) {
        res.end(JSON.stringify({ error: 'internal error' }));
      }
      console.error('[server] request handler failed:', (err as Error).message);
    });
  });

  srv.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      srv.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      srv.removeListener('error', onError);
      resolve();
    };
    srv.once('error', onError);
    srv.once('listening', onListening);
    srv.listen(port, HOST);
  });

  // A post-bind operational error would otherwise crash the process (unhandled
  // 'error' on an EventEmitter). Log and tear down instead of dying.
  srv.on('error', (err) => {
    console.error('[server] runtime error, stopping:', (err as Error).message);
    void stopServer();
  });

  server = srv;
  boundPort = port;
  const candidates = getConnectCandidates(port);
  console.log(`[server] bridge listening on ${HOST}:${port} — phone-reachable at:`);
  for (const c of candidates) console.log(`  [${c.label}] ${c.url}`);
  if (candidates.length === 0) {
    console.log('  (no LAN/Tailscale address detected yet)');
  }
}

/** Stop the bridge server if running. Destroys open sockets so it closes promptly. */
export function stopServer(): Promise<void> {
  const srv = server;
  if (!srv) return Promise.resolve();
  server = null;
  boundPort = null;
  for (const s of sockets) s.destroy();
  sockets.clear();
  return new Promise<void>((resolve) => {
    srv.close(() => resolve());
  });
}

/**
 * Reconcile the running server with settings: start it when enabled (and not
 * already on the right port), stop it when disabled, and restart on a port
 * change. Called at startup and whenever settings change. A bind failure
 * (EADDRINUSE) is logged and the server stays stopped — it never crashes the app.
 */
export async function syncServerToSettings(settings: AppSettings): Promise<void> {
  if (transitioning) return;
  transitioning = true;
  try {
    const { enabled, port } = settings.server;
    if (!enabled) {
      await stopServer();
      return;
    }
    // Enabled: (re)start if not running, or running on a different port.
    if (server && boundPort === port) return;
    if (server) await stopServer();
    try {
      await startServer(port);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EADDRINUSE') {
        console.error(
          `[server] port ${port} is already in use — bridge server NOT started. ` +
            'Pick another port in Settings → Remote.',
        );
      } else {
        console.error('[server] failed to start:', (err as Error).message);
      }
      // Make sure no half-open server lingers.
      await stopServer();
    }
  } finally {
    transitioning = false;
  }
}
