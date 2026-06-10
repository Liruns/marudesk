/**
 * External MCP connector types shared by the renderer and main process.
 *
 * marudesk exposes user-configured external MCP servers over stdio, Streamable
 * HTTP, and SSE. This file owns the persisted config shape, renderer-safe status
 * shape, and defensive config sanitization for hand-edited JSON.
 */

export type McpTransport = 'stdio' | 'http' | 'sse';

type McpServerBase = {
  readonly id: string;
  readonly enabled: boolean;
  readonly trust?: boolean;
  readonly disabledTools?: string[];
  readonly autoApproveTools?: string[];
  readonly confirmTools?: string[];
};

export type McpStdioServerConfig = McpServerBase & {
  readonly transport?: 'stdio';
  readonly command: string;
  readonly args?: string[];
  readonly env?: Record<string, string>;
};

export type McpHttpServerConfig = McpServerBase & {
  readonly transport: 'http' | 'sse';
  readonly url: string;
  readonly headers?: Record<string, string>;
};

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export type McpServersFile = {
  readonly servers: McpServerConfig[];
};

export type McpConfigDiagnosticSeverity = 'warning' | 'error';

export type McpConfigDiagnostic = {
  readonly severity: McpConfigDiagnosticSeverity;
  readonly code: string;
  readonly message: string;
  readonly index?: number;
  readonly serverId?: string;
  readonly field?: string;
};

export type McpConfigSanitizeResult = {
  readonly file: McpServersFile;
  readonly diagnostics: readonly McpConfigDiagnostic[];
};

export type McpConfigHealth = {
  readonly path: string;
  readonly exists: boolean;
  readonly ok: boolean;
  readonly diagnostics: readonly McpConfigDiagnostic[];
};

export function isHttpMcpConfig(c: McpServerConfig): c is McpHttpServerConfig {
  return c.transport === 'http' || c.transport === 'sse';
}

export function mcpTransportOf(c: McpServerConfig): McpTransport {
  return isHttpMcpConfig(c) ? c.transport : 'stdio';
}

export function mcpDisplayTarget(c: McpServerConfig): string {
  if (!isHttpMcpConfig(c)) return c.command;
  try {
    const u = new URL(c.url);
    return `${u.origin}${u.pathname}`.replace(/\/$/, '') || u.origin;
  } catch {
    return c.url.split('?')[0];
  }
}

export type McpConnectionState =
  | 'connected'
  | 'connecting'
  | 'reconnecting'
  | 'disabled'
  | 'error';

export type McpServerStatus = {
  readonly id: string;
  readonly transport: McpTransport;
  readonly target: string;
  readonly enabled: boolean;
  readonly trusted: boolean;
  readonly disabledTools: string[];
  readonly autoApproveTools: string[];
  readonly confirmTools: string[];
  readonly state: McpConnectionState;
  readonly toolCount: number;
  readonly tools?: string[];
  readonly error?: string;
};

export const MAX_MCP_SERVERS = 50;
const MAX_DISABLED_TOOLS = 200;
const MAX_AUTO_APPROVE_TOOLS = 200;
const MAX_CONFIRM_TOOLS = 200;
const MAX_STDIO_ARGS = MAX_MCP_SERVERS * 4;
export const MAX_MCP_MODEL_TOOL_NAME = 64;
const MCP_SAFE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const KNOWN_TRANSPORTS = new Set(['stdio', 'http', 'sse']);

export function isSafeMcpName(value: string): boolean {
  return value.length > 0 && value.length <= MAX_MCP_MODEL_TOOL_NAME && MCP_SAFE_NAME_PATTERN.test(value);
}

export function isSafeMcpNamespacedToolName(serverId: string, toolName: string): boolean {
  return (
    isSafeMcpName(serverId) &&
    isSafeMcpName(toolName) &&
    `${serverId}__${toolName}`.length <= MAX_MCP_MODEL_TOOL_NAME
  );
}

function diag(
  severity: McpConfigDiagnosticSeverity,
  code: string,
  message: string,
  extra: Omit<McpConfigDiagnostic, 'severity' | 'code' | 'message'> = {},
): McpConfigDiagnostic {
  return { severity, code, message, ...extra };
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function parseStringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseStringList(value: unknown, max: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= max) break;
  }
  return out.length > 0 ? out : undefined;
}

function normalizePolicyLists(
  serverId: string,
  index: number,
  lists: {
    readonly disabledTools?: string[];
    readonly autoApproveTools?: string[];
    readonly confirmTools?: string[];
  },
  diagnostics: McpConfigDiagnostic[],
): {
  readonly disabledTools?: string[];
  readonly autoApproveTools?: string[];
  readonly confirmTools?: string[];
} {
  const disabled = lists.disabledTools ?? [];
  const disabledSet = new Set(disabled);
  const confirm: string[] = [];
  for (const tool of lists.confirmTools ?? []) {
    if (disabledSet.has(tool)) {
      diagnostics.push(
        diag('warning', 'policy_conflict', `Tool "${tool}" is hidden, so it was removed from confirmTools.`, {
          index,
          serverId,
          field: 'confirmTools',
        }),
      );
      continue;
    }
    confirm.push(tool);
  }

  const confirmSet = new Set(confirm);
  const auto: string[] = [];
  for (const tool of lists.autoApproveTools ?? []) {
    const disabledConflict = disabledSet.has(tool);
    const confirmConflict = confirmSet.has(tool);
    if (disabledConflict || confirmConflict) {
      diagnostics.push(
        diag(
          'warning',
          'policy_conflict',
          `Tool "${tool}" was removed from autoApproveTools because ${
            disabledConflict ? 'disabledTools' : 'confirmTools'
          } has precedence.`,
          { index, serverId, field: 'autoApproveTools' },
        ),
      );
      continue;
    }
    auto.push(tool);
  }

  return {
    ...(disabled.length > 0 ? { disabledTools: disabled } : {}),
    ...(auto.length > 0 ? { autoApproveTools: auto } : {}),
    ...(confirm.length > 0 ? { confirmTools: confirm } : {}),
  };
}

export function sanitizeMcpConfigWithDiagnostics(input: unknown): McpConfigSanitizeResult {
  const diagnostics: McpConfigDiagnostic[] = [];
  const root = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  if (input && typeof input === 'object' && 'servers' in root && !Array.isArray(root.servers)) {
    diagnostics.push(diag('error', 'servers_not_array', 'MCP config field "servers" must be an array.', { field: 'servers' }));
  }
  const rawServers = Array.isArray(root.servers) ? root.servers : [];
  const seen = new Set<string>();
  const servers: McpServerConfig[] = [];

  for (const [index, raw] of rawServers.entries()) {
    if (servers.length >= MAX_MCP_SERVERS) {
      diagnostics.push(diag('warning', 'server_limit', `Only the first ${MAX_MCP_SERVERS} valid MCP servers are honored.`, { index }));
      break;
    }
    if (!raw || typeof raw !== 'object') {
      diagnostics.push(diag('warning', 'server_not_object', 'Dropped a non-object MCP server entry.', { index }));
      continue;
    }

    const r = raw as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id.trim() : '';
    if (!id) {
      diagnostics.push(diag('warning', 'missing_id', 'Dropped an MCP server entry with no id.', { index }));
      continue;
    }
    if (!isSafeMcpName(id)) {
      diagnostics.push(
        diag('error', 'invalid_id', `Dropped MCP server "${id}" because its id is not tool-name safe.`, {
          index,
          serverId: id,
          field: 'id',
        }),
      );
      continue;
    }
    if (seen.has(id)) {
      diagnostics.push(
        diag('warning', 'duplicate_id', `Dropped duplicate MCP server id "${id}"; the first entry wins.`, {
          index,
          serverId: id,
          field: 'id',
        }),
      );
      continue;
    }

    const command = typeof r.command === 'string' ? r.command.trim() : '';
    const url = typeof r.url === 'string' ? r.url.trim() : '';
    const declared = typeof r.transport === 'string' ? r.transport : '';
    if (declared && !KNOWN_TRANSPORTS.has(declared)) {
      diagnostics.push(
        diag('warning', 'unknown_transport', `MCP server "${id}" has unknown transport "${declared}".`, {
          index,
          serverId: id,
          field: 'transport',
        }),
      );
    }
    const wantsHttp = declared === 'http' || declared === 'sse' || (!command && !!url);

    const enabled = r.enabled !== false;
    const trust = r.trust === true;
    const disabledTools = parseStringList(r.disabledTools, MAX_DISABLED_TOOLS);
    const autoApproveTools = parseStringList(r.autoApproveTools, MAX_AUTO_APPROVE_TOOLS);
    const confirmTools = parseStringList(r.confirmTools, MAX_CONFIRM_TOOLS);
    const policy = normalizePolicyLists(id, index, { disabledTools, autoApproveTools, confirmTools }, diagnostics);
    const common = {
      id,
      enabled,
      ...(trust ? { trust: true as const } : {}),
      ...policy,
    };

    if (wantsHttp) {
      if (!isHttpUrl(url)) {
        diagnostics.push(
          diag('error', 'invalid_url', `Dropped MCP server "${id}" because its url is not http(s).`, {
            index,
            serverId: id,
            field: 'url',
          }),
        );
        continue;
      }
      const transport: 'http' | 'sse' = declared === 'sse' ? 'sse' : 'http';
      const headers = parseStringMap(r.headers);
      servers.push({ ...common, transport, url, ...(headers ? { headers } : {}) });
      seen.add(id);
      continue;
    }

    if (!command) {
      diagnostics.push(
        diag('error', 'missing_command', `Dropped MCP server "${id}" because it has no command or url.`, {
          index,
          serverId: id,
          field: 'command',
        }),
      );
      continue;
    }
    const args = Array.isArray(r.args)
      ? r.args.filter((a): a is string => typeof a === 'string').slice(0, MAX_STDIO_ARGS)
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

  return { file: { servers }, diagnostics };
}

export function sanitizeMcpConfig(input: unknown): McpServersFile {
  return sanitizeMcpConfigWithDiagnostics(input).file;
}
