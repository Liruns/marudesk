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
  /** Executable to spawn (e.g. `npx`, `node`, an absolute path). */
  command: string;
  /** Command-line arguments. */
  args?: string[];
  /** Extra environment for the child process (values may be secret — never logged). */
  env?: Record<string, string>;
  /** Whether the manager should connect this server. Disabled servers never spawn. */
  enabled: boolean;
};

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
  command: string;
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
    const command = typeof r.command === 'string' ? r.command.trim() : '';
    if (!id || !command) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const args = Array.isArray(r.args)
      ? r.args.filter((a): a is string => typeof a === 'string')
      : undefined;
    let env: Record<string, string> | undefined;
    if (r.env && typeof r.env === 'object' && !Array.isArray(r.env)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(r.env as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v;
      }
      if (Object.keys(out).length > 0) env = out;
    }
    servers.push({
      id,
      command,
      ...(args && args.length > 0 ? { args } : {}),
      ...(env ? { env } : {}),
      // Default to enabled when the field is absent (Claude-Desktop config omits it
      // for active servers); only an explicit `false` disables.
      enabled: r.enabled !== false,
    });
  }
  return { servers };
}
