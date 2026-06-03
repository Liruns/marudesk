import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { scrubText } from '../../shared/scrub';
import {
  isRemoteMcp,
  mcpTarget,
  type McpConnectionState,
  type McpServerConfig,
  type McpServerStatus,
} from '../../shared/mcp';
import { registerMcpServer, unregisterMcpServer, type McpServer } from './mcp';
import type { McpTool, ToolResult } from './tools';

/**
 * External (stdio) MCP connector manager (docs/remote-mobile-bridge-design §M3).
 *
 * THE invariant: marudesk's agent loop never auto-executes tools — it lists
 * schemas only and routes each call back through `callMcpTool` for approval /
 * read-only / ask_user mediation (electron/agent/loop.ts). So we DO NOT use the AI
 * SDK's `experimental_createMCPClient` (it attaches an auto-running `execute`).
 * Instead we drive the official low-level `@modelcontextprotocol/sdk` `Client`
 * ourselves: `client.listTools()` to discover, and each wrapped tool's `exec`
 * calls `client.callTool(...)`. The wrapped tool is a plain {@link McpTool}, so the
 * loop mediates it exactly like a built-in one.
 *
 * Tool metadata: external tools are namespaced `<id>__<tool>`, grouped `'mcp'`, and
 * `gated: true` by default — they're third-party and side-effecting, so the user
 * approves each call (unless Auto mode). They are NOT marked `write` (that would
 * make read-only mode blanket-refuse even read tools); gating is the control.
 *
 * Graceful failure: a server that fails to spawn / initialize is logged, marked
 * `error`, and skipped — it never crashes the app. The default config is empty, so
 * this ships inert (nothing is spawned until the user configures a server).
 */

/** How long to wait for spawn + MCP `initialize` before giving up on a server. */
const CONNECT_TIMEOUT_MS = 10_000;
/** Per tool-call timeout passed to `client.callTool`. */
const CALL_TIMEOUT_MS = 60_000;
/** Bound a tool result before scrubbing so a huge payload can't be fully scanned. */
const MAX_TOOL_TEXT = 24_000;

/** The subset of the MCP `Client` the manager uses — lets the harness inject a mock. */
export type McpClientLike = {
  listTools(): Promise<{ tools: McpExternalToolInfo[] }>;
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: undefined,
    options?: { timeout?: number },
  ): Promise<McpCallToolResult>;
  close(): Promise<void>;
};

/** A tool as reported by `client.listTools()` (only the fields we consume). */
export type McpExternalToolInfo = {
  name: string;
  description?: string;
  inputSchema?: { type: 'object'; properties?: Record<string, object>; required?: string[] };
};

/** Content item of a `client.callTool` result (text / image / other). */
type McpContentItem =
  | { type: 'text'; text: string }
  | { type: string; [k: string]: unknown };

/** Shape of `client.callTool`'s resolved value (only the fields we map). */
export type McpCallToolResult = {
  content?: McpContentItem[];
  isError?: boolean;
  [k: string]: unknown;
};

/** A live connection: its client, the registered server, and current status. */
type LiveServer = {
  config: McpServerConfig;
  client: McpClientLike;
  status: McpServerStatus;
};

/** Registry of currently connected servers, keyed by config id (= server name). */
const live = new Map<string, LiveServer>();
/** Latest status per configured id (incl. disabled/errored ones the UI lists). */
const statuses = new Map<string, McpServerStatus>();

function setStatus(
  config: McpServerConfig,
  state: McpConnectionState,
  toolCount: number,
  error?: string,
): McpServerStatus {
  const status: McpServerStatus = {
    id: config.id,
    transport: isRemoteMcp(config) ? 'http' : 'stdio',
    target: mcpTarget(config),
    enabled: config.enabled,
    state,
    toolCount,
    ...(error ? { error: scrubText(error) } : {}),
  };
  statuses.set(config.id, status);
  return status;
}

/**
 * Map one `client.callTool` result into marudesk's {@link ToolResult}. MCP returns
 * a content ARRAY (text / image / resource …); we join the text parts and note any
 * non-text part by type (the model can ask for it differently). Text is scrubbed at
 * egress (a third-party tool may echo secrets). `isError` carries through.
 */
function toToolResult(name: string, res: McpCallToolResult): ToolResult {
  const items = Array.isArray(res.content) ? res.content : [];
  const parts: string[] = [];
  for (const item of items) {
    if (item && item.type === 'text' && typeof (item as { text?: unknown }).text === 'string') {
      parts.push((item as { text: string }).text);
    } else if (item && typeof item.type === 'string') {
      parts.push(`[${item.type} content omitted]`);
    }
  }
  let text = parts.join('\n').trim() || '(no content)';
  if (text.length > MAX_TOOL_TEXT) {
    text = `${text.slice(0, MAX_TOOL_TEXT)}\n…[clipped ${text.length - MAX_TOOL_TEXT} chars]`;
  }
  return {
    summary: name,
    text: scrubText(text),
    isError: res.isError === true,
  };
}

/**
 * Wrap a connected client's tools as namespaced {@link McpTool}s. Each `exec`
 * strips the `<id>__` prefix back to the server's own tool name and calls
 * `client.callTool` (with a timeout); the loop mediates it via callMcpTool. A
 * thrown SDK error (timeout / transport) is caught here into an error ToolResult so
 * one bad call can't break the turn. Exported for the headless harness.
 */
export function buildExternalServer(
  id: string,
  client: McpClientLike,
  tools: McpExternalToolInfo[],
): McpServer {
  const prefix = `${id}__`;
  const wrapped: McpTool[] = tools
    .filter((t) => typeof t.name === 'string' && t.name.length > 0)
    .map((t) => {
      const toolName = t.name;
      const namespaced = `${prefix}${toolName}`;
      // Pass the server's own schema through; fall back to a permissive object
      // schema if it omitted one (a tool with no declared inputs).
      const inputSchema = t.inputSchema ?? { type: 'object' as const, properties: {} };
      const tool: McpTool = {
        name: namespaced,
        description: t.description
          ? `[${id}] ${t.description}`
          : `[${id}] external MCP tool "${toolName}".`,
        inputSchema,
        group: 'mcp',
        gated: true,
        async exec(input): Promise<ToolResult> {
          try {
            const res = await client.callTool(
              { name: toolName, arguments: (input ?? {}) as Record<string, unknown> },
              undefined,
              { timeout: CALL_TIMEOUT_MS },
            );
            return toToolResult(namespaced, res);
          } catch (err) {
            return {
              summary: `${namespaced} error`,
              text: `${namespaced} failed — ${scrubText((err as Error).message)}`,
              isError: true,
            };
          }
        },
      };
      return tool;
    });
  return { name: id, tools: wrapped };
}

/**
 * Default connect factory: dispatch to the Streamable-HTTP transport for a
 * remote (`url`) server, else spawn over stdio. Overridable by the harness via
 * {@link connectServer} so the wrapping logic is testable without a real
 * process or network.
 */
async function connectDefault(config: McpServerConfig): Promise<{ client: McpClientLike }> {
  return isRemoteMcp(config) ? connectHttp(config) : connectStdio(config);
}

/** Connect to a remote MCP server over Streamable HTTP (hosted MCPs). */
async function connectHttp(config: McpServerConfig): Promise<{ client: McpClientLike }> {
  const transport = new StreamableHTTPClientTransport(new URL(config.url ?? ''), {
    // Headers may carry an Authorization bearer — never logged.
    ...(config.headers ? { requestInit: { headers: config.headers } } : {}),
  });
  const client = new Client({ name: 'marudesk', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
  return { client: client as unknown as McpClientLike };
}

/** Factory for the real stdio client. */
async function connectStdio(config: McpServerConfig): Promise<{ client: McpClientLike }> {
  const transport = new StdioClientTransport({
    command: config.command ?? '',
    args: config.args ?? [],
    // Merge the inherited safe env with the user's overrides. Values may be
    // secret — they're never logged.
    env: { ...getInheritedEnv(), ...(config.env ?? {}) },
    // Pipe stderr so a spawn error surfaces in our log, not the user's console.
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'marudesk', version: '0.1.0' },
    { capabilities: {} },
  );
  // connect() spawns the process and runs the MCP initialize handshake; bound by a
  // connect timeout so a hung server can't wedge the manager.
  await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
  return { client: client as unknown as McpClientLike };
}

/** A minimal safe env to inherit (avoid leaking the full parent env to children). */
function getInheritedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ['PATH', 'Path', 'HOME', 'USERPROFILE', 'APPDATA', 'TEMP', 'TMP', 'SystemRoot', 'PATHEXT']) {
    const v = process.env[key];
    if (typeof v === 'string') out[key] = v;
  }
  return out;
}

/**
 * Connect one server: spawn, initialize, list its tools, wrap them, and register.
 * The `connect` factory is injectable so the headless harness can exercise the
 * wrapping/registration against a mock client without spawning a real process.
 * Never throws — failure is logged + recorded as `error` status (graceful).
 */
export async function connectServer(
  config: McpServerConfig,
  connect: (c: McpServerConfig) => Promise<{ client: McpClientLike }> = connectDefault,
): Promise<McpServerStatus> {
  setStatus(config, 'connecting', 0);
  try {
    const { client } = await connect(config);
    let tools: McpExternalToolInfo[];
    try {
      const listed = await client.listTools();
      tools = Array.isArray(listed?.tools) ? listed.tools : [];
    } catch (err) {
      await client.close().catch(() => {});
      throw err;
    }
    const server = buildExternalServer(config.id, client, tools);
    registerMcpServer(server);
    const status = setStatus(config, 'connected', server.tools.length);
    live.set(config.id, { config, client, status });
    console.log(`[mcp] connected "${config.id}" — ${server.tools.length} tool(s)`);
    return status;
  } catch (err) {
    const message = (err as Error).message || 'failed to connect';
    // Don't log the message verbatim (args/env could be sensitive) — id + a scrubbed
    // reason is enough to debug.
    console.error(`[mcp] server "${config.id}" failed to connect: ${scrubText(message)}`);
    return setStatus(config, 'error', 0, message);
  }
}

/** Disconnect one live server: unregister its tools + close the transport. */
async function disconnectServer(id: string): Promise<void> {
  const entry = live.get(id);
  if (!entry) return;
  live.delete(id);
  unregisterMcpServer(id);
  await entry.client.close().catch(() => {});
}

/**
 * Reconcile the live connections with a config list: disconnect servers that were
 * removed or disabled or whose command/args/env changed, then connect any enabled
 * server that isn't already live. Disabled/removed servers keep a status row so the
 * UI still lists them. Called at startup and whenever the config changes.
 *
 * The `connect` factory is injectable for the harness; production passes the real
 * stdio connector.
 */
export async function syncExternalMcpServers(
  configs: McpServerConfig[],
  connect?: (c: McpServerConfig) => Promise<{ client: McpClientLike }>,
): Promise<McpServerStatus[]> {
  const byId = new Map(configs.map((c) => [c.id, c] as const));

  // Drop status rows for ids no longer in the config at all.
  for (const id of [...statuses.keys()]) {
    if (!byId.has(id)) statuses.delete(id);
  }

  // Disconnect anything that should no longer be live (removed / disabled / changed).
  for (const id of [...live.keys()]) {
    const next = byId.get(id);
    if (!next || !next.enabled || configChanged(live.get(id)!.config, next)) {
      await disconnectServer(id);
    }
  }

  // Record disabled servers (so they appear in the UI) and connect enabled ones
  // that aren't already live.
  for (const config of configs) {
    if (!config.enabled) {
      if (!live.has(config.id)) setStatus(config, 'disabled', 0);
      continue;
    }
    if (live.has(config.id)) continue;
    // Connect sequentially — a slow/hung server is bounded by CONNECT_TIMEOUT_MS,
    // and configs are few. Each call is graceful (never throws).
    await connectServer(config, connect ?? connectStdio);
  }

  return listMcpServerStatuses();
}

/** Whether a server's spawn-affecting fields changed (forces a reconnect). */
function configChanged(a: McpServerConfig, b: McpServerConfig): boolean {
  return (
    a.command !== b.command ||
    a.url !== b.url ||
    JSON.stringify(a.args ?? []) !== JSON.stringify(b.args ?? []) ||
    JSON.stringify(a.env ?? {}) !== JSON.stringify(b.env ?? {}) ||
    JSON.stringify(a.headers ?? {}) !== JSON.stringify(b.headers ?? {})
  );
}

/** Current status of every configured server (connected, disabled, or errored). */
export function listMcpServerStatuses(): McpServerStatus[] {
  return [...statuses.values()];
}

/** Tear down every live connection (called on app quit). */
export async function disposeExternalMcpServers(): Promise<void> {
  const ids = [...live.keys()];
  await Promise.all(ids.map((id) => disconnectServer(id)));
  statuses.clear();
}
