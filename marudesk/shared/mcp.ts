/**
 * External MCP connectors — shared renderer↔main types
 * (docs/remote-mobile-bridge-design §7 ②b / §M3, extended in docs/context-mcp-design §8).
 *
 * marudesk ships an in-process built-in MCP server (electron/agent/mcp.ts). M3
 * makes it a real MCP *client* too: user-configured external servers are surfaced
 * to the agent over a transport — **stdio** (like Claude Desktop's `mcpServers`) or
 * **remote HTTP** (Streamable HTTP, with an SSE fallback) — and, critically, every
 * call is still routed back through the loop's approval / read-only / ask_user
 * mediation (the wrapper calls `client.callTool` itself; we never use the AI SDK's
 * auto-executing MCP client). See electron/agent/mcp-external.ts.
 *
 * These are pure types so the Settings UI and the main-process manager agree on the
 * config shape and the per-server status the UI renders.
 */

/** Which transport a configured server speaks. `stdio` is the default. */
export type McpTransport = 'stdio' | 'http' | 'sse';

/** Fields shared by every configured server regardless of transport. */
type McpServerBase = {
  /** Stable id; also the tool namespace (`<id>__<tool>`). */
  id: string;
  /** Whether the manager should connect this server. Disabled servers never connect. */
  enabled: boolean;
  /**
   * Trust the server enough to skip the per-call approval prompt for its tools
   * (they run like a built-in tool, still under read-only/auto mode rules). Default
   * `false` — untrusted servers are `gated` and approved per call. Only set this for
   * a server you control or fully trust; its tools can have side effects.
   */
  trust?: boolean;
  /**
   * Tool names (the server's own, un-namespaced) to HIDE from the agent — a
   * per-server allow/deny so a noisy or dangerous tool can be withheld without
   * disabling the whole server.
   */
  disabledTools?: string[];
};

/** A local server spawned over stdio (Claude-Desktop-style). */
export type McpStdioServerConfig = McpServerBase & {
  /** Omitted or `'stdio'`. */
  transport?: 'stdio';
  /** Executable to spawn (e.g. `npx`, `node`, an absolute path). */
  command: string;
  /** Command-line arguments. */
  args?: string[];
  /** Extra environment for the child process (values may be secret — never logged). */
  env?: Record<string, string>;
};

/** A remote server reached over HTTP (Streamable HTTP, or legacy SSE). */
export type McpHttpServerConfig = McpServerBase & {
  /** `'http'` = Streamable HTTP (preferred, falls back to SSE); `'sse'` = legacy SSE only. */
  transport: 'http' | 'sse';
  /** Server endpoint (must be http(s)). */
  url: string;
  /** Extra request headers, e.g. `Authorization` (values may be secret — never logged). */
  headers?: Record<string, string>;
};

/**
 * One configured external MCP server, as persisted in `userData/mcp-servers.json`.
 * Hand-editable (Claude-Desktop-style), so the main-process reader validates it
 * defensively — see {@link sanitizeMcpConfig}.
 */
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

/** The whole config file. */
export type McpServersFile = {
  servers: McpServerConfig[];
};

/** Narrowing helper: whether a config speaks a remote (HTTP/SSE) transport. */
export function isHttpMcpConfig(c: McpServerConfig): c is McpHttpServerConfig {
  return c.transport === 'http' || c.transport === 'sse';
}

/** The transport a config uses (stdio when unset). */
export function mcpTransportOf(c: McpServerConfig): McpTransport {
  return isHttpMcpConfig(c) ? c.transport : 'stdio';
}

/**
 * A short, secret-safe label for a server's endpoint, shown in Settings. For stdio
 * it's the command; for HTTP it's the URL origin + path only (query/hash dropped so
 * a token in the URL never reaches the renderer or a log).
 */
export function mcpDisplayTarget(c: McpServerConfig): string {
  if (!isHttpMcpConfig(c)) return c.command;
  try {
    const u = new URL(c.url);
    return `${u.origin}${u.pathname}`.replace(/\/$/, '') || u.origin;
  } catch {
    // Shouldn't happen post-sanitize, but never surface a raw/partial token.
    return c.url.split('?')[0];
  }
}

/** Connection lifecycle state of a configured server, for the Settings UI. */
export type McpConnectionState = 'connected' | 'connecting' | 'disabled' | 'error';

/**
 * Per-server status surfaced to the renderer (Settings → MCP Servers). Never
 * carries `env`/`headers` values, the full URL with secrets, or any other secret —
 * only what the UI shows.
 */
export type McpServerStatus = {
  id: string;
  /** Which transport the server speaks (stdio / http / sse). */
  transport: McpTransport;
  /** Secret-safe endpoint label (command, or URL origin+path) — see {@link mcpDisplayTarget}. */
  target: string;
  enabled: boolean;
  /** Whether this server's tools auto-approve (the `trust` flag, after sanitize). */
  trusted: boolean;
  state: McpConnectionState;
  /** How many tools the server exposed (0 unless connected). */
  toolCount: number;
  /** The exposed tool names (un-namespaced), present when `state === 'connected'`. */
  tools?: string[];
  /** Short failure reason when `state === 'error'` (already secret-safe). */
  error?: string;
};

/** Max number of configured servers honored from the file (defense against a huge hand-edit). */
export const MAX_MCP_SERVERS = 50;
/** Max number of `disabledTools` entries honored per server (defense against a huge hand-edit). */
const MAX_DISABLED_TOOLS = 200;

/** Whether a string is a syntactically valid http(s) URL. */
function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Parse a `Record<string,string>` field (env/headers), dropping non-string values. */
function parseStringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Parse a `string[]` field, dropping non-strings/blanks and bounding the length. */
function parseStringList(value: unknown, max: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
    .map((a) => a.trim())
    .slice(0, max);
  return out.length > 0 ? out : undefined;
}

/**
 * Coerce arbitrary parsed JSON into a valid {@link McpServersFile}. The file is
 * untrusted (hand-edited / on disk), so every field is checked: a bad entry is
 * dropped rather than throwing, and ids are de-duplicated (first wins) so the tool
 * namespace stays unique. Pure + total — never throws.
 *
 * Transport inference (so existing Claude-Desktop-style configs keep working): an
 * entry is HTTP when it declares `transport: 'http'|'sse'` OR carries a `url` and no
 * `command`; otherwise it's stdio and needs a `command`. A malformed entry for its
 * inferred transport (e.g. an http entry with a non-http url) is dropped.
 */
export function sanitizeMcpConfig(input: unknown): McpServersFile {
  const root = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const rawServers = Array.isArray(root.servers) ? root.servers : [];
  const seen = new Set<string>();
  const servers: McpServerConfig[] = [];
  for (const raw of rawServers) {
    if (servers.length >= MAX_MCP_SERVERS) break;
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id.trim() : '';
    if (!id || seen.has(id)) continue;

    const command = typeof r.command === 'string' ? r.command.trim() : '';
    const url = typeof r.url === 'string' ? r.url.trim() : '';
    const declared = typeof r.transport === 'string' ? r.transport : '';
    const wantsHttp = declared === 'http' || declared === 'sse' || (!command && !!url);

    // Fields common to both transports.
    const enabled = r.enabled !== false; // absent → enabled (Claude-Desktop omits it)
    const trust = r.trust === true;
    const disabledTools = parseStringList(r.disabledTools, MAX_DISABLED_TOOLS);
    const common = {
      id,
      enabled,
      ...(trust ? { trust: true as const } : {}),
      ...(disabledTools ? { disabledTools } : {}),
    };

    if (wantsHttp) {
      // Require a syntactically valid http(s) URL; anything else is dropped.
      if (!isHttpUrl(url)) continue;
      const transport: 'http' | 'sse' = declared === 'sse' ? 'sse' : 'http';
      const headers = parseStringMap(r.headers);
      servers.push({ ...common, transport, url, ...(headers ? { headers } : {}) });
      seen.add(id);
      continue;
    }

    // stdio (default).
    if (!command) continue;
    // args keep every string as-is (an empty/whitespace arg can be intentional),
    // only bounded — unlike disabledTools which are trimmed identifiers.
    const args = Array.isArray(r.args)
      ? r.args.filter((a): a is string => typeof a === 'string').slice(0, MAX_MCP_SERVERS * 4)
      : undefined;
    const env = parseStringMap(r.env);
    servers.push({
      ...common,
      command,
      ...(args && args.length > 0 ? { args } : {}),
      ...(env ? { env } : {}),
    });
    seen.add(id);
  }
  return { servers };
}
