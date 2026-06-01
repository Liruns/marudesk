import { scrubText } from '../../shared/scrub';
import {
  ASK_USER_DEF,
  BUILTIN_TOOLS,
  type McpTool,
  type McpToolDef,
  type ToolContext,
  type ToolResult,
} from './tools';
import { CONTEXT_TOOLS } from './context-sources';

/**
 * The MCP registry (docs/context-mcp-design §1.1) — the "one merge point" the v4
 * design (§B5) called for. The AI Chat ships ONE built-in server, `marudesk`,
 * that exposes every context source as a tool; the loop builds its tool set from
 * {@link listMcpTools} and routes execution through {@link callMcpTool}, so the
 * approval / read-only / ask_user mediation in loop.ts is preserved (the AI SDK's
 * own MCP client would auto-execute and bypass all of that — hence in-process).
 *
 * A future external (stdio/remote) MCP server implements the same {@link McpServer}
 * shape and registers via {@link registerMcpServer}; its tools would be namespaced
 * `<server>_<tool>` and merge here with no loop changes.
 */

export interface McpServer {
  readonly name: string;
  readonly tools: McpTool[];
}

/** The built-in context server: the original tools + the new context sources. */
const builtinServer: McpServer = {
  name: 'marudesk',
  tools: [...BUILTIN_TOOLS, ...CONTEXT_TOOLS],
};

const servers: McpServer[] = [builtinServer];

/** Register an additional MCP server (future external connectors). Name-unique. */
export function registerMcpServer(server: McpServer): void {
  if (!servers.some((s) => s.name === server.name)) servers.push(server);
}

function allTools(): McpTool[] {
  return servers.flatMap((s) => s.tools);
}

function index(): Map<string, McpTool> {
  return new Map(allTools().map((t) => [t.name, t] as const));
}

/**
 * Every tool the model may call, for `aiTools()`. Includes `ask_user` (which the
 * loop intercepts and never routes to {@link callMcpTool}). `aiTools` reads only
 * name/description/inputSchema and attaches no `execute`, so the extra fields
 * (incl. `exec`) ride along harmlessly — the loop still mediates every call.
 */
export function listMcpTools(): McpToolDef[] {
  return [...allTools(), ASK_USER_DEF];
}

/** A tool's full descriptor (incl. flags), or undefined if unknown. */
export function getMcpToolDef(name: string): McpToolDef | undefined {
  if (name === ASK_USER_DEF.name) return ASK_USER_DEF;
  return index().get(name);
}

/** Whether a tool requires explicit per-call approval (eval_js, cookies, …). */
export function isGatedTool(name: string): boolean {
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
