import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import type { AppliedChange } from '../../shared/patch';
import type { PluginExecResult } from '../../shared/plugin';
import { globToRegExp } from '../../shared/glob';
import { scrubText } from '../../shared/scrub';
import { inheritSafeEnv } from '../proc-env';
import type { ToolContext } from '../agent/tools';
import { applyPatch } from '../patch';
import { assertRealInsideRoot, resolveWorkspacePath } from '../fs-safe';
import { guardedGet, BlockedHostError } from '../net-guard';

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

/** Per-request socket timeout for a plugin fetch. */
const FETCH_TIMEOUT_MS = 15_000;

/**
 * `ctx.http.fetch` — host-mediated outbound GET (design §4). Enforced host-side:
 * https/http only, host must be in the plugin's manifest allowlist, and the
 * resolved IPs must be public (SSRF / DNS-rebinding / cloud-metadata guard, via
 * the shared {@link guardedGet}: resolve → validate → pin-to-IP with hostname
 * SNI). Redirects are NOT followed (a 3xx is returned as-is so a redirect can't
 * bounce to a blocked host), and the body is capped. The worker can't open raw
 * sockets (the Module._load shim + Permission Model), so this is the only network
 * path.
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
  // The shared guard resolves + validates + pins the connection. maxRedirects: 0
  // returns a 3xx as-is so a redirect can never bounce to a blocked host. The body
  // is truncated (not rejected) at MAX_FETCH_BYTES.
  let total = 0;
  try {
    const res = await guardedGet(
      parsed,
      (chunk) => {
        const room = MAX_FETCH_BYTES - total;
        if (room <= 0) return false; // cap reached: stop, keep what we have
        total += Math.min(chunk.length, room);
        return true;
      },
      {
        headers: { 'user-agent': 'marudesk-plugin' },
        timeoutMs: FETCH_TIMEOUT_MS,
        maxRedirects: 0,
      },
    );
    // The onData cap may have admitted a final chunk that overshoots the limit;
    // trim the concatenated body to the exact byte budget.
    const body = res.body.length > MAX_FETCH_BYTES ? res.body.subarray(0, MAX_FETCH_BYTES) : res.body;
    return { status: res.status, text: body.toString('utf8') };
  } catch (err) {
    if (err instanceof BlockedHostError) {
      throw new Error(`plugin net: "${host}" resolves to a non-public address`, { cause: err });
    }
    throw err instanceof Error ? err : new Error('plugin net: request failed');
  }
}
