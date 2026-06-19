import http from 'node:http';
import type { Socket } from 'node:net';
import { unlink, writeFile } from 'node:fs/promises';
import { handleRequest, type RouterDeps } from './router';

/**
 * The loopback companion listener (chat CLI v2 — docs/chat-cli-tui-design.md §3):
 * an always-on, 127.0.0.1-ONLY http server serving the pure router (router.ts) so
 * a local terminal client (cli/) can drive the agent loop.
 *
 * Loopback-only by construction:
 *  - binds loopback on an EPHEMERAL port — unreachable off-machine;
 *  - `/pair` 404s — there is no pairing or off-machine transport;
 *  - no L-1 approval guard — the bearer token only ever leaves main via the
 *    0600 handshake file below, so presenting it proves "same user, same
 *    machine": that IS the desktop user, who may approve gated tools.
 *
 * This module is Electron-free (paths/deps injected) so the companion harness
 * can exercise the full lifecycle headlessly, like the router harness.
 */

export type CompanionOptions = {
  /** Router deps — token, version, agent api, subscribe, extras. */
  deps: RouterDeps;
  /**
   * Absolute path of the same-user handshake file (`cli-bridge.json`):
   * `{ port, token, version }`, mode 0600, present ONLY while listening —
   * the Chrome `DevToolsActivePort` pattern. null ⇒ don't write one (harness).
   */
  handshakeFile: string | null;
};

export type CompanionHandle = {
  /** The bound loopback port. */
  port: number;
  /** Base URL clients should use, e.g. `http://127.0.0.1:52114`. */
  url: string;
  /** Stop listening, destroy open sockets, remove the handshake file. */
  close(): Promise<void>;
};

const HOST = '127.0.0.1';

export async function startCompanionServer(
  opts: CompanionOptions,
): Promise<CompanionHandle> {
  const { deps, handshakeFile } = opts;

  const srv = http.createServer((req, res) => {
    // Never let a handler rejection crash the process; surface a 500 instead.
    void handleRequest(req, res, deps).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      }
      if (!res.writableEnded) {
        res.end(JSON.stringify({ error: 'internal error' }));
      }
      console.error('[companion] request handler failed:', (err as Error).message);
    });
  });

  // Track live sockets so close() doesn't hang on keep-alive / open SSE streams.
  const sockets = new Set<Socket>();
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
    // Port 0: the OS picks a free ephemeral port — no EADDRINUSE, no setting.
    srv.listen(0, HOST);
  });

  // A post-bind operational error would otherwise crash the process (unhandled
  // 'error' on an EventEmitter). Log it; close() still cleans up.
  srv.on('error', (err) => {
    console.error('[companion] runtime error:', (err as Error).message);
  });

  const address = srv.address();
  if (address === null || typeof address === 'string') {
    srv.close();
    throw new Error('companion bind returned no port');
  }
  const port = address.port;

  if (handshakeFile) {
    try {
      await writeFile(
        handshakeFile,
        JSON.stringify({ port, token: deps.token, version: deps.version }),
        { mode: 0o600 },
      );
    } catch (err) {
      // The embedded path injects the connection via env, so a failed handshake
      // write only degrades EXTERNAL terminals — log, don't fail the listener.
      console.error('[companion] could not write handshake file:', (err as Error).message);
    }
  }

  let closed = false;
  const close = (): Promise<void> => {
    if (closed) return Promise.resolve();
    closed = true;
    if (handshakeFile) void unlink(handshakeFile).catch(() => {});
    for (const s of sockets) s.destroy();
    sockets.clear();
    return new Promise<void>((resolve) => {
      srv.close(() => resolve());
    });
  };

  return { port, url: `http://${HOST}:${port}`, close };
}
