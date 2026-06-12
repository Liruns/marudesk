import http from 'node:http';
import type { Socket } from 'node:net';
import { hostname } from 'node:os';
import { app } from 'electron';
import type { AppSettings } from '../../shared/settings';
import type { PairingRequestInfo, PairingStartInfo, ServerStatus } from '../../shared/remote';
import { subscribeAgentEvents, subscribeWorkspaceAgentEvents } from '../agent/loop';
import { defineHandler } from '../ipc/define-handler';
import { nonEmptyStr, obj } from '../ipc/validate';
import { getSettingsSync } from '../settings';
import { createApprovalGuard } from './approval-guard';
import { addDevice, deviceResolver, listDeviceInfos, revokeDevice } from './devices';
import { createRouterExtras } from './extras';
import { LOOP_AGENT_API } from './loop-api';
import { getConnectCandidates } from './pairing-urls';
import { createPairingManager } from './pairing';
import { projectRemoteCallback, projectRemoteState } from './remote-state';
import { handleRequest, type RouterDeps } from './router';
import { getServerToken } from './token';
import { getTunnelStatus, getTunnelUrl, setTunnelChangeListener, startTunnel, stopTunnel } from './tunnel';

/**
 * Lifecycle for the PC-side headless bridge server (docs/remote-mobile-bridge-design
 * §M4, T2 secure pairing in docs/t2-secure-pairing-design.md). The server runs IN
 * the Electron main process and calls the agent loop's exported functions DIRECTLY
 * (no IPC), relaying state to the companion app over SSE + REST.
 *
 * Security invariants (also enforced in ./router.ts):
 * - Binds 0.0.0.0 (all interfaces) so a phone on the LAN or Tailscale can reach it
 *   (T2 — docs/remote-mobile-bridge-design §3). Exposure is gated by: OFF by
 *   default, a Settings warning, and authentication on every route.
 * - Two authenticated paths: a bearer token (loopback companion) and per-device
 *   E2E (a paired phone — X25519/AES-GCM, possession of the session key = identity).
 *   `/pair` is the only anonymous route, itself gated by a one-time code + proof +
 *   desktop approval.
 * - OFF by default — only listens when settings.server.enabled is true.
 */

const HOST = '0.0.0.0';

let server: http.Server | null = null;
/** The port we're currently listening on (so a port change restarts the server). */
let boundPort: number | null = null;
/** Guards against overlapping start/stop while an async start is in flight. */
let transitioning = false;
// Track live sockets so stop() doesn't hang on keep-alive / open SSE connections.
const sockets = new Set<Socket>();
/** Renderer status-push sink (wired once from main.ts). */
let onStatus: ((status: ServerStatus) => void) | null = null;
/** Renderer pairing-request sink (wired once from main.ts). */
let onPairingRequest: ((info: PairingRequestInfo) => void) | null = null;

/**
 * The singleton pairing manager (docs/t2-secure-pairing-design §2). Persists a
 * paired device via the device store and forwards each approval request to the
 * renderer (the user approves/rejects in Settings → Remote).
 */
const pairing = createPairingManager({
  addDevice,
  onPairingRequest: (info) => onPairingRequest?.(info),
  // Unattended mode (Settings → Remote → "Skip approvals"): auto-approve pairing.
  shouldAutoApprove: () => {
    const s = getSettingsSync().server;
    return s.enabled && s.skipApprovals;
  },
});

/** Whether the bridge server is currently listening. */
export function isServerRunning(): boolean {
  return server !== null;
}

/** Wire the renderer status-push once (from main.ts); see `server:status-changed`. */
export function setServerStatusListener(fn: (status: ServerStatus) => void): void {
  onStatus = fn;
}

/** Wire the renderer pairing-request push once (from main.ts); see `server:pairing-request`. */
export function setPairingRequestListener(fn: (info: PairingRequestInfo) => void): void {
  onPairingRequest = fn;
}

/**
 * Begin a pairing: mint a QR (the PC public key + the reachable URLs + a one-time
 * code) for the phone to scan. Requires the server to be running so the candidate
 * URLs are real.
 */
function startPairing(): Promise<PairingStartInfo> {
  const status = getServerStatus();
  if (!status.running) throw new Error('turn the local server on before pairing a device');
  return pairing.startPairing({ urls: status.candidates, pcName: hostname() });
}

/**
 * The sanitized status the renderer may see — running flag, bound port, and the
 * reachable LAN/Tailscale URLs (computed live while running). Never the token.
 * Recomputes candidates per call (it shells out to Tailscale with a short
 * timeout), so it's read on demand / on start-stop, not polled.
 */
export function getServerStatus(): ServerStatus {
  if (!server || boundPort === null) {
    return { running: false, port: null, candidates: [] };
  }
  // The user-configured public URL and the managed auto-tunnel join the
  // candidates, so the pairing QR carries a from-anywhere address with zero
  // phone-side setup.
  const { publicUrl } = getSettingsSync().server;
  return {
    running: true,
    port: boundPort,
    candidates: getConnectCandidates(boundPort, publicUrl, getTunnelUrl() ?? undefined),
    tunnel: getTunnelStatus() ?? undefined,
  };
}

// A tunnel state change (URL captured, process died, …) changes the reachable
// candidates — push the refreshed status to the renderer right away.
setTunnelChangeListener(() => onStatus?.(getServerStatus()));

/**
 * Register the `server:*` IPC handlers. Status + device pairing/management; never
 * returns the bearer token or any device session key (only sanitized info).
 */
export function registerServerHandlers(): void {
  defineHandler('server:status', () => getServerStatus());
  defineHandler('server:pairing-start', () => startPairing());
  defineHandler('server:pairing-approve', ([payload]) =>
    pairing.approve(nonEmptyStr(obj(payload).approvalId, 'approvalId')),
  );
  defineHandler('server:pairing-reject', ([payload]) =>
    pairing.reject(nonEmptyStr(obj(payload).approvalId, 'approvalId')),
  );
  defineHandler('server:list-devices', () => listDeviceInfos());
  defineHandler('server:revoke-device', ([payload]) =>
    revokeDevice(nonEmptyStr(obj(payload).deviceId, 'deviceId')),
  );
}

/** Start the bridge server on `port` (binds all interfaces). No-op if already running. */
export async function startServer(port: number): Promise<void> {
  if (server) return;
  // Resolve the bearer token up front (mints + persists one on first need) so a
  // request can never race an unset token.
  const token = await getServerToken();
  const deps: RouterDeps = {
    token,
    version: app.getVersion(),
    agent: LOOP_AGENT_API,
    // Every published frame is remote-projected (bounded editDiffs in place of
    // the heavy per-edit before/after) — same projection LOOP_AGENT_API.snapshot
    // applies, so the pull and push paths can't drift.
    subscribe: (cb) => subscribeAgentEvents(projectRemoteCallback(cb)),
    // Workspace-scoped stream for `GET /agent/events?workspace=<id>`: filter the
    // loop's per-workspace fan-out down to the one workspace this SSE client
    // joined, so a phone sees exactly what the desktop's workspace chat shows.
    subscribeWorkspace: (workspaceId, cb) =>
      subscribeWorkspaceAgentEvents((wsId, state) => {
        if (wsId === workspaceId) cb(projectRemoteState(state));
      }),
    // T2: the per-device E2E auth path + the /pair endpoint (paired phones over
    // LAN/Tailscale). The bearer path stays for the loopback companion.
    devices: deviceResolver,
    pair: (body) => pairing.handlePair(body),
    // T2 L-1: a remote peer can't self-approve gated tools while exposed — those
    // approvals stay pinned to the desktop UI (docs/t2-secure-pairing-design.md §8).
    approvalGuard: createApprovalGuard(),
    // Catalog routes (chat CLI v2) — same picker data as the loopback companion.
    extras: createRouterExtras(),
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

  // M-2 (design §10.1): bound slow clients so an exposed port can't be held open
  // by a slowloris-style drip. These only cap RECEIVING a request — the long-lived
  // SSE *response* stream is unaffected (its request arrives in one packet).
  srv.headersTimeout = 15_000;
  srv.requestTimeout = 30_000;
  srv.keepAliveTimeout = 5_000;

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
  // Compute the reachable URLs once and reuse them for the boot log AND the
  // renderer push (one Tailscale shell-out, no divergence between the two).
  const status = getServerStatus();
  console.log(`[server] bridge listening on ${HOST}:${port} — phone-reachable at:`);
  for (const c of status.candidates) console.log(`  [${c.label}] ${c.url}`);
  if (status.candidates.length === 0) {
    console.log('  (no LAN/Tailscale address detected yet)');
  }
  onStatus?.(status);
}

/** Stop the bridge server if running. Destroys open sockets so it closes promptly. */
export function stopServer(): Promise<void> {
  // The tunnel fronts the server — it never outlives it.
  stopTunnel();
  const srv = server;
  if (!srv) return Promise.resolve();
  server = null;
  boundPort = null;
  for (const s of sockets) s.destroy();
  sockets.clear();
  // State already reflects "stopped" — tell the renderer right away (candidates → []).
  onStatus?.(getServerStatus());
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
    const { enabled, port, tunnelEnabled } = settings.server;
    if (!enabled) {
      await stopServer();
      return;
    }
    // Enabled: (re)start if not running, or running on a different port.
    if (server && boundPort === port) {
      // No restart needed, but reconcile the tunnel toggle and refresh the
      // renderer's view — a settings edit (e.g. the public URL) may have
      // changed the reachable candidates.
      if (tunnelEnabled) startTunnel(port, app.getPath('userData'));
      else stopTunnel();
      onStatus?.(getServerStatus());
      return;
    }
    if (server) await stopServer();
    try {
      await startServer(port);
      if (tunnelEnabled) startTunnel(port, app.getPath('userData'));
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
