import { scrubText } from '../../shared/scrub';
import {
  ASK_USER_DEF,
  BUILTIN_TOOLS,
  SPAWN_SUBAGENT_DEF,
  type McpTool,
  type McpToolDef,
  type ToolContext,
  type ToolResult,
} from './tools';
import { CONTEXT_TOOLS } from './context-sources';
import { PC_CONTROL_TOOLS } from './pc-sources';
import { SKILL_TOOLS } from './skills-store';

/**
 * The MCP registry (docs/context-mcp-design §1.1) — the "one merge point" the v4
 * design (§B5) called for. The AI Chat ships ONE built-in server, `marudesk`,
 * that exposes every context source as a tool; the loop builds its tool set from
 * {@link listMcpTools} and routes execution through {@link callMcpTool}, so the
 * approval / read-only / ask_user mediation in loop.ts is preserved (the AI SDK's
 * own MCP client would auto-execute and bypass all of that — hence in-process).
 *
 * External (stdio) MCP servers (docs/remote-mobile-bridge-design §M3) implement
 * the same {@link McpServer} shape and register dynamically via
 * {@link registerMcpServer}; their tools are namespaced `<id>__<tool>` and each
 * `exec` calls the official MCP `client.callTool` itself — so the loop mediates an
 * external tool exactly like a built-in one. They're managed in mcp-external.ts.
 */

export interface McpServer {
  readonly name: string;
  readonly tools: McpTool[];
}

/** The built-in context server: the original tools + the new context sources. */
const builtinServer: McpServer = {
  name: 'marudesk',
  tools: [...BUILTIN_TOOLS, ...CONTEXT_TOOLS, ...PC_CONTROL_TOOLS, ...SKILL_TOOLS],
};

// The built-in `marudesk` server is always first and never replaced/unregistered;
// external connectors are appended/removed dynamically after it.
const servers: McpServer[] = [builtinServer];

/**
 * Cached name→tool index, rebuilt lazily on first use after the server set changes.
 * The loop calls {@link isWriteTool}/{@link isGatedTool} for EVERY tool invocation,
 * so rebuilding the map per call (flatMapping every server's tools each time) was
 * wasted work on a hot path; (un)register invalidates it instead. `null` = stale.
 */
let cachedIndex: Map<string, McpTool> | null = null;

/**
 * Register (or REPLACE by name) an MCP server. Replacing supports an external
 * connector reconnecting — the manager re-registers the same id with a fresh tool
 * set. Invalidates the tool index so {@link listMcpTools} / {@link callMcpTool} pick
 * up the change immediately. The built-in `marudesk` server stays first.
 */
export function registerMcpServer(server: McpServer): void {
  const i = servers.findIndex((s) => s.name === server.name);
  if (i === -1) servers.push(server);
  else servers[i] = server;
  cachedIndex = null;
}

/**
 * Remove a previously registered server by name (an external connector being
 * disabled, removed, or torn down at quit). No-op for the built-in `marudesk`
 * server or an unknown name. Returns whether anything was removed.
 */
export function unregisterMcpServer(name: string): boolean {
  if (name === builtinServer.name) return false;
  const i = servers.findIndex((s) => s.name === name);
  if (i === -1) return false;
  servers.splice(i, 1);
  cachedIndex = null;
  return true;
}

function allTools(): McpTool[] {
  return servers.flatMap((s) => s.tools);
}

function index(): Map<string, McpTool> {
  if (cachedIndex) return cachedIndex;
  cachedIndex = new Map(allTools().map((t) => [t.name, t] as const));
  return cachedIndex;
}

/**
 * Every tool the model may call, for `aiTools()`. Includes `ask_user` (which the
 * loop intercepts and never routes to {@link callMcpTool}). `aiTools` reads only
 * name/description/inputSchema and attaches no `execute`, so the extra fields
 * (incl. `exec`) ride along harmlessly — the loop still mediates every call.
 */
export function listMcpTools(): McpToolDef[] {
  return [...allTools(), SPAWN_SUBAGENT_DEF, ASK_USER_DEF];
}

/** A tool's full descriptor (incl. flags), or undefined if unknown. */
export function getMcpToolDef(name: string): McpToolDef | undefined {
  if (name === ASK_USER_DEF.name) return ASK_USER_DEF;
  if (name === SPAWN_SUBAGENT_DEF.name) return SPAWN_SUBAGENT_DEF;
  return index().get(name);
}

/** Whether a tool requires explicit per-call approval (eval_js, cookies, …). */
export function isGatedTool(name: string): boolean {
  if (name === SPAWN_SUBAGENT_DEF.name) return true;
  return !!index().get(name)?.gated;
}

/** Whether a tool mutates state (refused outright in read-only mode). */
export function isWriteTool(name: string): boolean {
  return !!index().get(name)?.write;
}

/**
 * Execute a tool through its owning server, catching thrown errors into a tool
 * error result (mirrors the old executeTool contract). ask_user never reaches
 * here — the loop handles it before calling this.
 */
export async function callMcpTool(
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = index().get(name);
  if (!tool) return { summary: `unknown tool ${name}`, text: `no such tool: ${name}`, isError: true };
  try {
    return await tool.exec((input ?? {}) as Record<string, unknown>, ctx);
  } catch (err) {
    return { summary: `${name} error`, text: `${name} failed — ${scrubText((err as Error).message)}`, isError: true };
  }
}
