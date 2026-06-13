import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/**
 * A transient loopback HTTP server for the OAuth redirect (docs/oauth-providers-design.md).
 * Binds `127.0.0.1` so it never triggers a firewall prompt (only public-interface
 * binds do) and is unreachable off-box. Prefers the provider's expected port, then
 * falls back to an ephemeral one and rebuilds the redirect URI from the actually
 * bound port (RFC 8252 — public clients accept any loopback port).
 *
 * The callback result is captured in a promise created at construction, so it's
 * race-free: the browser may hit the callback BEFORE `waitForCallback` is called
 * (the start→complete IPC gap) and the result is still delivered. `waitForCallback`
 * just races that promise against a timeout + abort.
 */

export type LoopbackResult = { code: string; state?: string };

export type LoopbackServer = {
  /** The redirect URI to send on authorize + token-exchange (must match exactly). */
  redirectUri: string;
  /** Resolve when the browser hits the callback path; reject on timeout/abort/error. */
  waitForCallback(timeoutMs: number, signal: AbortSignal): Promise<LoopbackResult>;
  close(): void;
};

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
    body{font:15px -apple-system,Segoe UI,sans-serif;background:#0b0c0e;color:#e6e7e9;
    display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
    .card{text-align:center;padding:32px 40px;border:1px solid #23262b;border-radius:14px;background:#121316}
    h1{font-size:17px;margin:0 0 8px} p{color:#9aa0a6;margin:0}
  </style></head><body><div class="card"><h1>${title}</h1><p>${body}</p></div></body></html>`;
}

const OK_PAGE = page('Maru — signed in', 'You can close this tab and return to Maru.');
const ERR_PAGE = page('Maru — sign-in failed', 'Something went wrong. Return to Maru and try again.');

/** Start the server, trying `ports` in order, then an ephemeral port if allowed. */
export async function startLoopbackServer(opts: {
  host: string;
  ports: number[];
  allowEphemeral: boolean;
  path: string;
}): Promise<LoopbackServer> {
  const { host, path } = opts;

  // The callback outcome is held as plain DATA (a value or an error), not a
  // free-floating Promise — so an error/deny that arrives before (or without) a
  // waiter can never surface as an unhandled rejection. First outcome wins; a
  // waiter registered later (the start→complete gap) still picks it up.
  let buffered: { result?: LoopbackResult; error?: Error } | null = null;
  let waiter: { resolve: (r: LoopbackResult) => void; reject: (e: Error) => void } | null = null;
  const deliver = (): void => {
    if (!buffered || !waiter) return;
    const w = waiter;
    waiter = null;
    if (buffered.result) w.resolve(buffered.result);
    else w.reject(buffered.error ?? new Error('sign-in failed'));
  };
  const settle = (outcome: { result?: LoopbackResult; error?: Error }): void => {
    if (!buffered) buffered = outcome; // first wins
    deliver();
  };

  const server = http.createServer((req, res) => {
    let pathname: string;
    let params: URLSearchParams;
    try {
      const url = new URL(req.url ?? '/', `http://${host}`);
      pathname = url.pathname;
      params = url.searchParams;
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (pathname !== path) {
      res.writeHead(404).end();
      return;
    }
    const error = params.get('error');
    const code = params.get('code');
    const state = params.get('state') ?? undefined;
    const ok = !error && !!code;
    res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
    res.end(ok ? OK_PAGE : ERR_PAGE);
    if (ok && code) settle({ result: { code, state } });
    else settle({ error: new Error(error ? `authorization failed: ${error}` : 'callback had no code') });
  });

  // Track sockets so close() doesn't hang on keep-alive connections.
  const sockets = new Set<Socket>();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  await listen(server, host, opts.ports, opts.allowEphemeral);
  // A post-bind operational error would otherwise crash the process (unhandled
  // 'error' on an EventEmitter). Fail the pending attempt instead (first wins).
  server.on('error', (err) => settle({ error: err instanceof Error ? err : new Error(String(err)) }));
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://${host}:${port}${path}`;

  return {
    redirectUri,
    close(): void {
      for (const s of sockets) s.destroy();
      sockets.clear();
      server.close();
    },
    waitForCallback(timeoutMs, signal): Promise<LoopbackResult> {
      return new Promise<LoopbackResult>((resolve, reject) => {
        let settled = false;
        const onAbort = (): void => finish(() => reject(new Error('cancelled')));
        const timer = setTimeout(
          () => finish(() => reject(new Error('timed out waiting for the sign-in to complete'))),
          timeoutMs,
        );
        const finish = (act: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          waiter = null;
          act();
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        waiter = { resolve: (r) => finish(() => resolve(r)), reject: (e) => finish(() => reject(e)) };
        if (buffered) deliver(); // already arrived (early-callback race)
      });
    },
  };
}

/** Try each port in `ports` in order; on EADDRINUSE move to the next, then (if
 * `allowEphemeral`) an OS-assigned port, else reject. Each attempt registers its
 * own one-shot error/listening pair and removes the sibling on settle, so no
 * stale listener survives onto the bound server. */
function listen(
  server: http.Server,
  host: string,
  ports: number[],
  allowEphemeral: boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // The remaining ports to try; an ephemeral (0) is appended last when allowed.
    const queue = [...ports, ...(allowEphemeral ? [0] : [])];
    const attempt = (): void => {
      const port = queue.shift();
      if (port === undefined) {
        reject(new Error('no free loopback port for the OAuth callback'));
        return;
      }
      const onError = (err: NodeJS.ErrnoException): void => {
        server.removeListener('listening', onListening);
        if (err.code === 'EADDRINUSE' && queue.length > 0) {
          attempt();
          return;
        }
        reject(err);
      };
      const onListening = (): void => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    };
    attempt();
  });
}
