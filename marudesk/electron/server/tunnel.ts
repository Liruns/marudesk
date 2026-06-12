import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { TunnelStatus } from '../../shared/remote';

/**
 * Managed cloudflared quick tunnel for the bridge server (Settings → Remote →
 * Advanced → Auto tunnel). While enabled and the server is running, main spawns
 * `cloudflared tunnel --url http://127.0.0.1:<port>`, scrapes the public
 * `https://….trycloudflare.com` URL from its output, and hands it to the
 * connect-candidate list — so the pairing QR carries a from-anywhere address
 * with zero manual tunnel setup on either device.
 *
 * Like the Tailscale detection in pairing-urls.ts this is best-effort and can
 * never crash main: a missing binary or a crashed process just surfaces as a
 * status (`unavailable` / `error`) the Settings UI shows. The quick-tunnel URL
 * is EPHEMERAL (it changes on every spawn); a stable `server.publicUrl` remains
 * the recommended setup for long-lived pairings, and when both are set the
 * stable URL outranks this one in the candidates.
 */

/** Matches the public URL cloudflared prints once the quick tunnel is up. */
const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

/**
 * Extract the quick-tunnel public URL from one chunk of cloudflared output, or
 * null. Pure — unit-tested in pair-harness.ts.
 */
export function parseTunnelUrl(chunk: string): string | null {
  const m = TUNNEL_URL_RE.exec(chunk);
  return m ? m[0] : null;
}

type TunnelState = {
  proc: ChildProcessByStdio<null, Readable, Readable> | null;
  status: TunnelStatus | null;
  /** The port the running tunnel fronts (a port change requires a respawn). */
  port: number | null;
};

const state: TunnelState = { proc: null, status: null, port: null };

/** Change sink (wired once from server/index.ts) — fires on every status change. */
let onChange: (() => void) | null = null;

export function setTunnelChangeListener(fn: () => void): void {
  onChange = fn;
}

function setStatus(next: TunnelStatus | null): void {
  state.status = next;
  onChange?.();
}

/** The tunnel's current status (null when the feature is off / stopped). */
export function getTunnelStatus(): TunnelStatus | null {
  return state.status;
}

/** The public base URL while the tunnel is up, else null. */
export function getTunnelUrl(): string | null {
  return state.status?.state === 'up' && state.status.url ? state.status.url : null;
}

/** Start the quick tunnel fronting `port`. No-op if already running for that port. */
export function startTunnel(port: number): void {
  if (state.proc && state.port === port) return;
  stopTunnel();
  state.port = port;
  setStatus({ state: 'starting' });

  let proc: ChildProcessByStdio<null, Readable, Readable>;
  try {
    proc = spawn(
      'cloudflared',
      ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
  } catch (err) {
    setStatus({ state: 'error', detail: (err as Error).message });
    return;
  }
  state.proc = proc;

  // cloudflared logs to stderr (the URL banner included); watch both anyway.
  const watch = (stream: Readable): void => {
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      if (state.proc !== proc) return; // a stale process after a restart
      const url = parseTunnelUrl(chunk);
      if (url && getTunnelUrl() !== url) setStatus({ state: 'up', url });
    });
  };
  watch(proc.stdout);
  watch(proc.stderr);

  proc.on('error', (err: NodeJS.ErrnoException) => {
    if (state.proc !== proc) return;
    state.proc = null;
    if (err.code === 'ENOENT') {
      setStatus({
        state: 'unavailable',
        detail: 'cloudflared not found — install it (or set a Public URL instead)',
      });
    } else {
      setStatus({ state: 'error', detail: err.message });
    }
  });

  proc.on('exit', (code) => {
    if (state.proc !== proc) return;
    state.proc = null;
    // A deliberate stop() already nulled the status; an unexpected exit is an error.
    if (state.status) {
      setStatus({ state: 'error', detail: `cloudflared exited (code ${code ?? 'signal'})` });
    }
  });
}

/** Stop the tunnel if running and clear its status. */
export function stopTunnel(): void {
  const proc = state.proc;
  state.proc = null;
  state.port = null;
  if (state.status) setStatus(null);
  if (proc) {
    try {
      proc.kill();
    } catch {
      // already dead — fine
    }
  }
}
