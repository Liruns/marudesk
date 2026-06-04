import fs from 'node:fs/promises';
import type { ToolContext } from '../agent/tools';
import { assertRealInsideRoot, resolveWorkspacePath } from '../fs-safe';

/**
 * Host-side capability guards for plugin `ctx.fs` / `ctx.http` RPCs
 * (docs/plugin-runtime-design.md §4). The worker can only reach the filesystem /
 * network through these, and only while a tool handler is running — the host
 * resolves the originating call's {@link ToolContext} from the RPC's `callId`
 * (§R2) and passes it here. No workspace ⇒ no fs access.
 *
 * These REUSE the workspace path guards (resolveWorkspacePath +
 * assertRealInsideRoot from fs-safe.ts) rather than reimplementing the
 * escape/symlink checks — the same machinery the built-in file tools use.
 */

/** Cap a single plugin file read so a huge file can't blow up the worker. */
const MAX_READ_BYTES = 512 * 1024;

function requireRoot(ctx: ToolContext): string {
  const root = ctx.ws?.root;
  if (!root) throw new Error('plugin fs: no workspace is open for this call');
  return root;
}

/** `ctx.fs.read` — read a workspace-relative file as UTF-8, guarded + bounded. */
export async function guardedRead(ctx: ToolContext, relPath: string): Promise<string> {
  const root = requireRoot(ctx);
  const { abs } = resolveWorkspacePath(root, relPath);
  await assertRealInsideRoot(root, abs);
  const data = await fs.readFile(abs, 'utf8');
  return data.length > MAX_READ_BYTES ? data.slice(0, MAX_READ_BYTES) : data;
}

/** `ctx.fs.list` — list a workspace-relative directory's immediate entries. */
export async function guardedList(ctx: ToolContext, relPath: string): Promise<string[]> {
  const root = requireRoot(ctx);
  const { abs } = resolveWorkspacePath(root, relPath);
  await assertRealInsideRoot(root, abs);
  const entries = await fs.readdir(abs, { withFileTypes: true });
  return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
}

/**
 * `ctx.http.fetch` — host-mediated outbound request. Deferred to P3 (design §4):
 * needs allowlist + SSRF / DNS-rebinding / redirect re-validation done host-side.
 * Until then it refuses, so a `net`-declaring plugin gets a clear error rather
 * than a silent capability.
 */
export async function guardedFetch(): Promise<{ status: number; text: string }> {
  throw new Error('plugin net access (ctx.http) is not available in this version');
}
