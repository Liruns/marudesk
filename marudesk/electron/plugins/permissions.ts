import { spawn } from 'node:child_process';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { AppliedChange } from '../../shared/patch';
import type { PluginExecResult } from '../../shared/plugin';
import { globToRegExp } from '../../shared/glob';
import { scrubText } from '../../shared/scrub';
import { inheritSafeEnv } from '../proc-env';
import type { ToolContext } from '../agent/tools';
import { applyPatch } from '../patch';
import { assertRealInsideRoot, resolveWorkspacePath } from '../fs-safe';

/**
 * Host-side capability guards for plugin `ctx.fs` / `ctx.http` RPCs
 * (docs/plugin-runtime-design.md §4). The worker can only reach the filesystem /
 * network through these, and only while a tool handler is running — the host
 * resolves the originating call's {@link ToolContext} from the RPC's `callId`
 * (§R2) and passes it here. No workspace ⇒ no fs access.
 *
 * These REUSE the workspace machinery rather than reimplementing it: reads use
 * resolveWorkspacePath + assertRealInsideRoot (the built-in file tools' guards),
 * and writes go through {@link applyPatch} — the same atomic, symlink-safe,
 * escape-checked apply the agent's edit_file uses — so a plugin write produces a
 * proper {@link AppliedChange} (before/after) that surfaces in the chat diff +
 * revert history, instead of mutating the workspace invisibly.
 */

/** Cap a single plugin file read so a huge file can't blow up the worker. */
const MAX_READ_BYTES = 512 * 1024;
/** Cap a single plugin write. */
const MAX_WRITE_BYTES = 1024 * 1024;
/** Cap a fetched response body before it crosses back to the worker. */
const MAX_FETCH_BYTES = 1024 * 1024;

function requireWorkspace(ctx: ToolContext): { root: string } {
  if (!ctx.ws?.root) throw new Error('plugin fs: no workspace is open for this call');
  return { root: ctx.ws.root };
}


/** `ctx.fs.read` — read a workspace-relative file as UTF-8, guarded + bounded. */
export async function guardedRead(ctx: ToolContext, relPath: string): Promise<string> {
  const { root } = requireWorkspace(ctx);
  const { abs } = resolveWorkspacePath(root, relPath);
  await assertRealInsideRoot(root, abs);
  const data = await fs.readFile(abs, 'utf8');
  return data.length > MAX_READ_BYTES ? data.slice(0, MAX_READ_BYTES) : data;
}

/** `ctx.fs.list` — list a workspace-relative directory's immediate entries. */
export async function guardedList(ctx: ToolContext, relPath: string): Promise<string[]> {
  const { root } = requireWorkspace(ctx);
  const { abs } = resolveWorkspacePath(root, relPath);
  await assertRealInsideRoot(root, abs);
  const entries = await fs.readdir(abs, { withFileTypes: true });
  return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
}

/**
 * `ctx.fs.write` — write/overwrite a workspace-relative text file through the
 * agent's atomic patch apply, returning the {@link AppliedChange} (or null for a
 * no-op identical write). Honors the agent's never-edit denyGlobs (§4) on top of
 * applyPatch's escape/symlink/atomicity guards. The host attaches the change to
 * the calling tool's result so it shows in the diff/revert history.
 */
export async function guardedWrite(
  ctx: ToolContext,
  relPath: string,
  data: string,
): Promise<AppliedChange | null> {
  const ws = ctx.ws;
  if (!ws?.root) throw new Error('plugin fs: no workspace is open for this call');
  if (typeof data !== 'string') throw new Error('plugin fs.write: data must be a string');
  if (data.length > MAX_WRITE_BYTES) throw new Error('plugin fs.write: content too large');
  const { rel, abs } = resolveWorkspacePath(ws.root, relPath);
  if (ctx.denyGlobs?.some((g) => globToRegExp(g).test(rel))) {
    throw new Error(`plugin fs.write: "${rel}" matches a denied path glob (Settings → Agent)`);
  }
  let current: string | null;
  try {
    current = await fs.readFile(abs, 'utf8');
  } catch {
    current = null; // new file
  }
  if (current !== null && current === data) return null; // no-op
  const res = await applyPatch(ws, [{ path: rel, oldString: current ?? '', newString: data }]);
  if (!res.ok || !res.changes || res.changes.length === 0) {
    const why = res.errors.map((e) => e.reason).join('; ') || 'write failed';
    throw new Error(`plugin fs.write: ${why}`);
  }
  return res.changes[0];
}

/** Cap captured exec output (mirror run_command's MAX_OUTPUT). */
const MAX_EXEC_OUTPUT = 60_000;
const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
const MIN_EXEC_TIMEOUT_MS = 1_000;
const MAX_EXEC_TIMEOUT_MS = 600_000;

function clampExecTimeout(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_EXEC_TIMEOUT_MS;
  return Math.min(MAX_EXEC_TIMEOUT_MS, Math.max(MIN_EXEC_TIMEOUT_MS, Math.floor(raw)));
}

/**
 * `ctx.exec` — run a workspace CLI (linter/formatter/build) through the HOST, the
 * SAME guarded spawn as the run_command tool: workspace root as cwd, secret-shaped
 * env stripped (inheritSafeEnv), output bounded, time-boxed, and killed on the
 * call's AbortSignal. The worker can NEVER spawn a process itself (the module shim
 * + Node Permission Model deny child_process), so this host path — gated on the
 * `cmd` permission at the call site — is the only way a plugin reaches a CLI.
 */
export function guardedExec(
  ctx: ToolContext,
  command: string,
  timeoutMs?: number,
): Promise<PluginExecResult> {
  const trimmed = typeof command === 'string' ? command.trim() : '';
  if (!trimmed) return Promise.reject(new Error('plugin exec: command must be a non-empty string'));
  if (!ctx.ws?.root) return Promise.reject(new Error('plugin exec: no workspace is open for this call'));
  const cwd = ctx.ws.root;
  const limit = clampExecTimeout(timeoutMs);
  return new Promise<PluginExecResult>((resolve, reject) => {
    // Same trust model as run_command: the command targets the user's machine and
    // is gated by the plugin `cmd` grant; shell interpretation is intended.
    const child = spawn(trimmed, { cwd, env: inheritSafeEnv(), shell: true });
    let output = '';
    let truncated = false;
    const append = (chunk: Buffer): void => {
      if (truncated) return;
      output += chunk.toString('utf8');
      if (output.length > MAX_EXEC_OUTPUT) {
        output = output.slice(0, MAX_EXEC_OUTPUT);
        truncated = true;
      }
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, limit);
    const onAbort = (): void => {
      child.kill();
    };
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    const cleanup = (): void => {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
    };
    child.on('error', (err) => {
      cleanup();
      reject(new Error(`plugin exec: failed to start — ${scrubText(err.message)}`));
    });
    child.on('close', (code) => {
      cleanup();
      const body = scrubText(output);
      resolve({
        exitCode: timedOut ? null : code,
        output: truncated ? `${body}\n…(output truncated to ${MAX_EXEC_OUTPUT} chars)` : body,
        timedOut,
      });
    });
  });
}

/** Reject hostnames that resolve to a private / loopback / link-local address. */
function isBlockedIp(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (v === 6) {
    const low = ip.toLowerCase();
    return (
      low === '::1' ||
      low === '::' ||
      low.startsWith('fe80') || // link-local
      low.startsWith('fc') ||
      low.startsWith('fd') || // unique-local
      low.startsWith('::ffff:') // IPv4-mapped — re-checked below by the caller
    );
  }
  return false;
}

/**
 * `ctx.http.fetch` — host-mediated outbound GET (design §4). Enforced host-side:
 * https/http only, host must be in the plugin's manifest allowlist, the resolved
 * IPs must be public (SSRF / DNS-rebinding / cloud-metadata guard), redirects are
 * NOT followed (a 3xx is returned as-is so a redirect can't bounce to a blocked
 * host), and the body is capped. The worker can't open raw sockets (the
 * Module._load shim + Permission Model), so this is the only network path.
 */
export async function guardedFetch(
  url: string,
  allow: readonly string[],
): Promise<{ status: number; text: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('plugin net: invalid URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('plugin net: only http(s) URLs are allowed');
  }
  const host = parsed.hostname.toLowerCase();
  if (!allow.map((h) => h.toLowerCase()).includes(host)) {
    throw new Error(`plugin net: host "${host}" is not in the plugin's net allowlist`);
  }
  // Resolve + validate every address the host maps to (DNS-rebinding guard).
  let addrs: string[];
  try {
    addrs = (await dns.lookup(host, { all: true })).map((a) => a.address);
  } catch {
    throw new Error(`plugin net: could not resolve "${host}"`);
  }
  if (addrs.length === 0 || addrs.some((ip) => isBlockedIp(ip.replace(/^::ffff:/i, '')))) {
    throw new Error(`plugin net: "${host}" resolves to a non-public address`);
  }
  // Pin the connection to a validated IP (audit H9). Global fetch would re-resolve
  // DNS independently of the lookup above, leaving a TOCTOU window where a hostile
  // authoritative server returns a public IP to the check and a private/metadata
  // IP to the actual connection. Connecting by IP closes that; for https we still
  // pass the hostname as TLS servername so the certificate is verified against the
  // real host (and as the Host header), so pinning can't be bypassed by rebinding.
  const pinned = addrs[0].replace(/^::ffff:/i, '');
  return pinnedGet(parsed, pinned, pinned.includes(':') ? 6 : 4);
}

/** GET against a pre-validated IP, keeping the hostname for Host header + TLS SNI. */
function pinnedGet(
  parsed: URL,
  ip: string,
  family: 4 | 6,
): Promise<{ status: number; text: string }> {
  const isHttps = parsed.protocol === 'https:';
  const lib = isHttps ? https : http;
  const port = parsed.port ? Number(parsed.port) : isHttps ? 443 : 80;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        host: ip,
        family,
        port,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        headers: { Host: parsed.host, 'user-agent': 'marudesk-plugin' },
        // TLS SNI + certificate validation target the real hostname, not the IP.
        ...(isHttps ? { servername: parsed.hostname } : {}),
        timeout: 15_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') });
        };
        res.on('data', (c: Buffer) => {
          if (settled) return;
          const room = MAX_FETCH_BYTES - total;
          if (room <= 0) {
            res.destroy();
            finish();
            return;
          }
          chunks.push(c.length > room ? c.subarray(0, room) : c);
          total += Math.min(c.length, room);
        });
        res.on('end', finish);
        res.on('error', (e) => {
          if (!settled) reject(e);
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('plugin net: request timed out')));
    req.on('error', reject);
    req.end();
  });
}
