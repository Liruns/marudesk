import { shell } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { scrubText } from '../../shared/scrub';
import { openExternalUrl } from '../safe-open';
import { getSettingsSync } from '../settings';
import type { McpTool, ToolContext, ToolResult } from './tools';

/**
 * PC control tools — the agent's reach OUTSIDE the workspace sandbox onto the
 * computer itself: open a file or folder in its default app, open a URL in the
 * system browser, reveal a path in the OS file manager. Any agent surface (the
 * desktop chat or a local terminal client) drives the same loop, which calls these.
 *
 * Two gates stack: (1) the Settings "PC control" permission (default OFF) — every
 * tool refuses until the user turns it on; (2) `gated` + `write` flags so each
 * call asks for approval (Ask mode) and is refused outright in read-only mode.
 * Nothing here runs arbitrary commands — that (run_command) is a separate,
 * higher-risk phase behind its own permission.
 */

/** http(s)/mailto/tel only — same allowlist safe-open.ts enforces for web content. */
const SAFE_EXTERNAL_SCHEME = /^(https?|mailto|tel):/i;

function pcEnabled(): boolean {
  return getSettingsSync().pcControl.enabled;
}

function disabledResult(tool: string): ToolResult {
  return {
    summary: `${tool} (disabled)`,
    text: 'PC control is off. Ask the user to enable it in Settings → AI Agent → "PC control" before using computer-control tools.',
    isError: true,
  };
}

/**
 * Resolve a user/agent-supplied path: expand a leading `~` to the home dir, and
 * resolve a workspace-relative path against the open folder. Absolute paths pass
 * through. (The whole point of PC control is to reach outside the sandbox, so
 * there's no fs-safe root guard here — the Settings permission + per-call
 * approval are the guard.)
 */
function resolvePcPath(input: string, ctx: ToolContext): string {
  let p = input.trim();
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    p = path.join(os.homedir(), p.slice(1));
  }
  if (!path.isAbsolute(p) && ctx.ws) p = path.join(ctx.ws.root, p);
  return path.normalize(p);
}

async function openPath(input: { path?: unknown }, ctx: ToolContext): Promise<ToolResult> {
  if (!pcEnabled()) return disabledResult('open_path');
  const raw = typeof input.path === 'string' ? input.path : '';
  if (!raw.trim()) throw new Error('open_path requires "path"');
  const target = resolvePcPath(raw, ctx);
  // shell.openPath resolves to '' on success, or an error string on failure.
  const err = await shell.openPath(target);
  if (err) {
    return { summary: 'open_path (failed)', text: `Could not open "${target}" — ${scrubText(err)}`, isError: true };
  }
  return { summary: `opened ${target}`, text: `Opened "${target}" with its default application.` };
}

async function openExternal(input: { url?: unknown }): Promise<ToolResult> {
  if (!pcEnabled()) return disabledResult('open_external');
  const url = typeof input.url === 'string' ? input.url.trim() : '';
  if (!url) throw new Error('open_external requires "url"');
  if (!SAFE_EXTERNAL_SCHEME.test(url)) {
    return {
      summary: 'open_external (blocked)',
      text: `Refused to open "${scrubText(url)}" — only http(s), mailto, and tel URLs may be opened externally.`,
      isError: true,
    };
  }
  const opened = await openExternalUrl(url);
  if (!opened) {
    return {
      summary: 'open_external (failed)',
      text: `The OS refused to open ${scrubText(url)} — no working default browser handler.`,
      isError: true,
    };
  }
  return { summary: `opened ${scrubText(url)}`, text: `Opened ${scrubText(url)} in the system browser.` };
}

async function revealInExplorer(input: { path?: unknown }, ctx: ToolContext): Promise<ToolResult> {
  if (!pcEnabled()) return disabledResult('reveal_in_explorer');
  const raw = typeof input.path === 'string' ? input.path : '';
  if (!raw.trim()) throw new Error('reveal_in_explorer requires "path"');
  const target = resolvePcPath(raw, ctx);
  shell.showItemInFolder(target);
  return { summary: `revealed ${target}`, text: `Revealed "${target}" in the OS file manager.` };
}

/* ── descriptors ────────────────────────────────────────────────────────── */

const strProp = (desc: string) => ({ type: 'string', description: desc });
const obj = (properties: Record<string, unknown>, required?: string[]) => ({
  type: 'object' as const,
  properties,
  ...(required ? { required } : {}),
  additionalProperties: false,
});

/**
 * The PC-control tools, as MCP descriptors. All are `gated` (per-call approval)
 * AND `write` (refused in read-only mode) AND additionally require the Settings
 * "PC control" permission — acting on the computer outside the workspace is the
 * most consequential thing the agent can do, so it's never silent.
 */
export const PC_CONTROL_TOOLS: McpTool[] = [
  {
    name: 'open_path',
    group: 'pc',
    gated: true,
    write: true,
    description:
      "Open a file or folder on the user's computer with its default application (e.g. open a PDF in the viewer, a folder in the file manager). The path may be absolute, ~-relative, or workspace-relative. Requires the 'PC control' permission; asks for approval.",
    inputSchema: obj({ path: strProp('Absolute, ~-relative, or workspace-relative path to open.') }, ['path']),
    exec: (input, ctx) => openPath(input, ctx),
  },
  {
    name: 'open_external',
    group: 'pc',
    gated: true,
    write: true,
    description:
      "Open a URL in the user's default web browser (http/https/mailto/tel only). Requires the 'PC control' permission; asks for approval.",
    inputSchema: obj({ url: strProp('http(s)/mailto/tel URL to open externally.') }, ['url']),
    exec: (input) => openExternal(input),
  },
  {
    name: 'reveal_in_explorer',
    group: 'pc',
    gated: true,
    write: true,
    description:
      "Show a file or folder in the OS file manager (Explorer / Finder), selecting it. The path may be absolute, ~-relative, or workspace-relative. Requires the 'PC control' permission; asks for approval.",
    inputSchema: obj({ path: strProp('Absolute, ~-relative, or workspace-relative path to reveal.') }, ['path']),
    exec: (input, ctx) => revealInExplorer(input, ctx),
  },
];
