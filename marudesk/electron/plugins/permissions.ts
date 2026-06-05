import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import net from 'node:net';
import type { AppliedChange } from '../../shared/patch';
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

/** Minimal glob→regexp (mirrors the agent's never-edit deny check). */
function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = esc.replace(/\*\*|\*/g, (m) => (m === '**' ? '.*' : '[^/]*'));
  return new RegExp(`^${body}$`, 'i');
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(parsed, { method: 'GET', redirect: 'manual', signal: controller.signal });
    const buf = await res.arrayBuffer();
    const slice = buf.byteLength > MAX_FETCH_BYTES ? buf.slice(0, MAX_FETCH_BYTES) : buf;
    return { status: res.status, text: new TextDecoder().decode(slice) };
  } finally {
    clearTimeout(timer);
  }
}
