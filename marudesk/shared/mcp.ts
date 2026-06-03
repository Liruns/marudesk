/**
 * External (stdio) MCP connectors — shared renderer↔main types
 * (docs/remote-mobile-bridge-design §7 ②b / §M3).
 *
 * marudesk ships an in-process built-in MCP server (electron/agent/mcp.ts). M3
 * makes it a real MCP *client* too: user-configured external servers are spawned
 * over stdio (like Claude Desktop's `mcpServers`), their tools are surfaced to the
 * agent, and — critically — every call is still routed back through the loop's
 * approval / read-only / ask_user mediation (the wrapper calls `client.callTool`
 * itself; we never use the AI SDK's auto-executing MCP client). See
 * electron/agent/mcp-external.ts.
 *
 * These are pure types so the Settings UI and the main-process manager agree on
 * the config shape and the per-server status the UI renders.
 */

/**
 * One configured external MCP server, as persisted in `userData/mcp-servers.json`.
 * Hand-editable (Claude-Desktop-style), so the main-process reader validates it
 * defensively — see {@link sanitizeMcpConfig}.
 */
export type McpServerConfig = {
  /** Stable id; also the tool namespace (`<id>__<tool>`). */
  id: string;
  /** Whether the manager should connect this server. Disabled servers never spawn. */
  enabled: boolean;
  /** stdio transport: executable to spawn (e.g. `npx`, `node`, an absolute path). */
  command?: string;
  /** Command-line arguments (stdio only). */
  args?: string[];
  /** Extra environment for the child process (stdio only; values may be secret — never logged). */
  env?: Record<string, string>;
  /**
   * Streamable-HTTP transport: a remote MCP server's URL (e.g. a hosted search /
   * docs MCP). Mutually exclusive with `command`; when set, the manager connects
   * over HTTP instead of spawning a process — so marudesk can use hosted MCPs,
   * not just local ones.
   */
  url?: string;
  /** Extra HTTP headers for the remote transport (e.g. `Authorization`; may be secret). */
  headers?: Record<string, string>;
};

/** Whether a server uses the remote (Streamable-HTTP) transport vs. local stdio. */
export function isRemoteMcp(c: McpServerConfig): boolean {
  return typeof c.url === 'string' && c.url.length > 0;
}

/** The human-facing connection target — the URL for remote, else the command. */
export function mcpTarget(c: McpServerConfig): string {
  return isRemoteMcp(c) ? (c.url ?? '') : (c.command ?? '');
}

/** The whole config file. */
export type McpServersFile = {
  servers: McpServerConfig[];
};

/** Connection lifecycle state of a configured server, for the Settings UI. */
export type McpConnectionState = 'connected' | 'connecting' | 'disabled' | 'error';

/**
 * Per-server status surfaced to the renderer (Settings → MCP Servers). Never
 * carries `env` values or other secrets — only what the UI shows.
 */
export type McpServerStatus = {
  id: string;
  /** Which transport this server uses. */
  transport: 'stdio' | 'http';
  /** The connection target shown in the UI — the command (stdio) or URL (http). */
  target: string;
  enabled: boolean;
  state: McpConnectionState;
  /** How many tools the server exposed (0 unless connected). */
  toolCount: number;
  /** Short failure reason when `state === 'error'` (already secret-safe). */
  error?: string;
};

/** Max number of configured servers honored from the file (defense against a huge hand-edit). */
export const MAX_MCP_SERVERS = 50;

/**
 * Coerce arbitrary parsed JSON into a valid {@link McpServersFile}. The file is
 * untrusted (hand-edited / on disk), so every field is checked: a bad entry is
 * dropped rather than throwing, and ids are de-duplicated (first wins) so the
 * tool namespace stays unique. Pure + total — never throws.
 */
/** Coerce a string→string map (env / headers), or undefined when empty/invalid. */
function sanitizeStringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A trimmed http(s) URL, or '' when the value isn't a usable remote URL. */
function sanitizeMcpUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const u = new URL(trimmed);
    return u.protocol === 'http:' || u.protocol === 'https:' ? trimmed : '';
  } catch {
    return '';
  }
}

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
    const url = sanitizeMcpUrl(r.url);
    // A server is either stdio (command) or remote (http url); url wins if both
    // are present. An entry with neither is dropped.
    if (!command && !url) continue;
    seen.add(id);
    // Default to enabled when the field is absent (Claude-Desktop config omits it
    // for active servers); only an explicit `false` disables.
    const enabled = r.enabled !== false;
    if (url) {
      const headers = sanitizeStringMap(r.headers);
      servers.push({ id, url, ...(headers ? { headers } : {}), enabled });
      continue;
    }
    const args = Array.isArray(r.args)
      ? r.args.filter((a): a is string => typeof a === 'string')
      : undefined;
    const env = sanitizeStringMap(r.env);
    servers.push({
      id,
      command,
      ...(args && args.length > 0 ? { args } : {}),
      ...(env ? { env } : {}),
      enabled,
    });
  }
  return { servers };
}
