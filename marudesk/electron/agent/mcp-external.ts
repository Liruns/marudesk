import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { scrubText } from '../../shared/scrub';
import {
  isHttpMcpConfig,
  mcpDisplayTarget,
  mcpTransportOf,
  type McpConnectionState,
  type McpServerConfig,
  type McpServerStatus,
} from '../../shared/mcp';
import { registerMcpServer, unregisterMcpServer, type McpServer } from './mcp';
import type { McpTool, ToolResult } from './tools';

/**
 * External MCP connector manager (docs/remote-mobile-bridge-design §M3, extended in
 * docs/context-mcp-design §8). Connects user-configured servers over **stdio** (a
 * spawned local process) or **remote HTTP** (Streamable HTTP, with a legacy SSE
 * fallback) and surfaces their tools to the agent loop.
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
 * approves each call (unless Auto mode). A server the user marks `trust: true` in
 * the config exposes its tools UN-gated (still under read-only/auto rules). External
 * tools are NOT marked `write` (that would make read-only mode blanket-refuse even
 * read tools); gating is the control. A server's `disabledTools` are filtered out
 * entirely so the model never sees them.
 *
 * Graceful failure: a server that fails to connect / initialize is logged, marked
 * `error`, and skipped — it never crashes the app. A connected server whose
 * transport later drops (process exit, network loss) is detected via the client's
 * `onclose` hook, marked `error`, and its tools removed. The default config is
 * empty, so this ships inert (nothing connects until the user configures a server).
 */

/** How long to wait for connect + MCP `initialize` before giving up on a server. */
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
  /** Invoked by the transport when the connection drops — we use it for crash detection. */
  onclose?: () => void;
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
  extra?: { error?: string; tools?: string[] },
): McpServerStatus {
  const status: McpServerStatus = {
    id: config.id,
    transport: mcpTransportOf(config),
    target: mcpDisplayTarget(config),
    enabled: config.enabled,
    trusted: config.trust === true,
    state,
    toolCount,
    ...(extra?.tools ? { tools: extra.tools } : {}),
    ...(extra?.error ? { error: scrubText(extra.error) } : {}),
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

/** Per-server wrapping options derived from the config (trust + tool filter). */
export type ExternalServerOptions = {
  /** When true, the server's tools are NOT gated (auto-approve). Default false. */
  trusted?: boolean;
  /** Tool names (un-namespaced) to hide from the agent entirely. */
  disabledTools?: readonly string[];
};

/**
 * Wrap a connected client's tools as namespaced {@link McpTool}s. Each `exec`
 * strips the `<id>__` prefix back to the server's own tool name and calls
 * `client.callTool` (with a timeout); the loop mediates it via callMcpTool. A
 * thrown SDK error (timeout / transport) is caught here into an error ToolResult so
 * one bad call can't break the turn.
 *
 * `opts.disabledTools` are filtered out (the model never sees them); `opts.trusted`
 * flips `gated` off so a trusted server's tools auto-approve. Exported for the
 * headless harness.
 */
export function buildExternalServer(
  id: string,
  client: McpClientLike,
  tools: McpExternalToolInfo[],
  opts: ExternalServerOptions = {},
): McpServer {
  const prefix = `${id}__`;
  const hidden = new Set(opts.disabledTools ?? []);
  const gated = opts.trusted !== true;
  const wrapped: McpTool[] = tools
    .filter((t) => typeof t.name === 'string' && t.name.length > 0 && !hidden.has(t.name))
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
        gated,
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

/** A fresh MCP `Client` with marudesk's identity (no special capabilities). */
function newClient(): Client {
  return new Client({ name: 'marudesk', version: '0.1.0' }, { capabilities: {} });
}

/**
 * Real connector factory — dispatches on transport. Overridable by the harness via
 * {@link connectServer} / {@link syncExternalMcpServers}. Stdio spawns a local
 * process; http/sse reach a remote endpoint.
 */
async function connectClient(config: McpServerConfig): Promise<{ client: McpClientLike }> {
  return isHttpMcpConfig(config) ? connectHttp(config) : connectStdio(config);
}

/** Spawn a local stdio MCP server and run the initialize handshake. */
async function connectStdio(config: McpServerConfig): Promise<{ client: McpClientLike }> {
  if (isHttpMcpConfig(config)) throw new Error('not a stdio config'); // unreachable; narrows the union
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    // Merge the inherited safe env with the user's overrides. Values may be
    // secret — they're never logged.
    env: { ...getInheritedEnv(), ...(config.env ?? {}) },
    // Pipe stderr so a spawn error surfaces in our log, not the user's console.
    stderr: 'pipe',
  });
  const client = newClient();
  // connect() spawns the process and runs the MCP initialize handshake; bound by a
  // connect timeout so a hung server can't wedge the manager.
  await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
  return { client: client as unknown as McpClientLike };
}

/**
 * Connect to a remote MCP server. For `transport: 'http'` we try Streamable HTTP
 * first (the current spec transport) and, on a connect failure, fall back to legacy
 * SSE — many older hosted servers still only speak SSE. For `transport: 'sse'` we go
 * straight to SSE. User headers (e.g. `Authorization`) ride on every request; their
 * values are secret and never logged.
 */
async function connectHttp(config: McpServerConfig): Promise<{ client: McpClientLike }> {
  if (!isHttpMcpConfig(config)) throw new Error('not an http config'); // unreachable; narrows the union
  const url = new URL(config.url);
  const requestInit = config.headers ? { headers: config.headers } : undefined;

  // For SSE the initial stream is a GET whose headers come from a custom fetch
  // (EventSourceInit can't carry headers); reuse it for the POST channel too so
  // auth headers apply uniformly.
  const headerFetch: typeof fetch | undefined = config.headers
    ? (input, init) =>
        fetch(input, { ...init, headers: { ...(init?.headers ?? {}), ...config.headers } })
    : undefined;

  const tryConnect = async (kind: 'http' | 'sse'): Promise<McpClientLike> => {
    const client = newClient();
    const transport =
      kind === 'http'
        ? new StreamableHTTPClientTransport(url, { requestInit })
        : new SSEClientTransport(url, { requestInit, ...(headerFetch ? { fetch: headerFetch } : {}) });
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    return client as unknown as McpClientLike;
  };

  if (config.transport === 'sse') return { client: await tryConnect('sse') };
  try {
    return { client: await tryConnect('http') };
  } catch (err) {
    // Streamable HTTP failed — retry as SSE before giving up (graceful downgrade).
    console.warn(`[mcp] "${config.id}" Streamable HTTP failed, trying SSE fallback`);
    try {
      return { client: await tryConnect('sse') };
    } catch {
      // Surface the original (more informative) Streamable HTTP error.
      throw err;
    }
  }
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
  connect: (c: McpServerConfig) => Promise<{ client: McpClientLike }> = connectClient,
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
    const server = buildExternalServer(config.id, client, tools, {
      trusted: config.trust === true,
      disabledTools: config.disabledTools,
    });
    registerMcpServer(server);
    const toolNames = server.tools.map((t) => t.name.slice(`${config.id}__`.length));
    const status = setStatus(config, 'connected', server.tools.length, { tools: toolNames });
    live.set(config.id, { config, client, status });
    // Crash detection: if the transport drops after we're connected, drop the dead
    // tools and mark the server errored so the agent + UI stop seeing stale tools.
    client.onclose = () => handleUnexpectedClose(config.id);
    console.log(`[mcp] connected "${config.id}" — ${server.tools.length} tool(s)`);
    return status;
  } catch (err) {
    const message = (err as Error).message || 'failed to connect';
    // Don't log the message verbatim (args/env/headers could be sensitive) — id + a
    // scrubbed reason is enough to debug.
    console.error(`[mcp] server "${config.id}" failed to connect: ${scrubText(message)}`);
    return setStatus(config, 'error', 0, { error: message });
  }
}

/**
 * Handle a live server's transport closing unexpectedly (process exit, network
 * loss). We unregister its tools so the agent can't call into a dead connection and
 * mark it `error` for the UI. A deliberate teardown (disconnectServer) clears the
 * `onclose` first, so this only fires on real drops.
 */
function handleUnexpectedClose(id: string): void {
  const entry = live.get(id);
  if (!entry) return;
  live.delete(id);
  unregisterMcpServer(id);
  console.error(`[mcp] server "${id}" connection closed unexpectedly`);
  setStatus(entry.config, 'error', 0, { error: 'connection closed' });
}

/** Disconnect one live server: unregister its tools + close the transport. */
async function disconnectServer(id: string): Promise<void> {
  const entry = live.get(id);
  if (!entry) return;
  live.delete(id);
  unregisterMcpServer(id);
  // Detach the crash handler first — this is a deliberate teardown, not a drop.
  entry.client.onclose = undefined;
  await entry.client.close().catch(() => {});
}

/**
 * Reconcile the live connections with a config list: disconnect servers that were
 * removed or disabled or whose command/args/env changed, then connect any enabled
 * server that isn't already live. Disabled/removed servers keep a status row so the
 * UI still lists them. Called at startup and whenever the config changes.
 *
 * The `connect` factory is injectable for the harness; production passes the real
 * transport-dispatching connector.
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
    await connectServer(config, connect ?? connectClient);
  }

  return listMcpServerStatuses();
}

/**
 * Whether a server's connection-affecting fields changed (forces a reconnect).
 * Covers the transport, its endpoint/secrets, and the wrapping options (trust /
 * disabledTools) — the latter change the tool set the agent sees, so a reconnect
 * re-wraps them.
 */
function configChanged(a: McpServerConfig, b: McpServerConfig): boolean {
  if (mcpTransportOf(a) !== mcpTransportOf(b)) return true;
  if (a.trust !== b.trust) return true;
  if (JSON.stringify(a.disabledTools ?? []) !== JSON.stringify(b.disabledTools ?? [])) return true;
  if (isHttpMcpConfig(a) && isHttpMcpConfig(b)) {
    return (
      a.url !== b.url ||
      JSON.stringify(a.headers ?? {}) !== JSON.stringify(b.headers ?? {})
    );
  }
  if (!isHttpMcpConfig(a) && !isHttpMcpConfig(b)) {
    return (
      a.command !== b.command ||
      JSON.stringify(a.args ?? []) !== JSON.stringify(b.args ?? []) ||
      JSON.stringify(a.env ?? {}) !== JSON.stringify(b.env ?? {})
    );
  }
  return true; // transport kind differs in a way the guards above didn't catch
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
