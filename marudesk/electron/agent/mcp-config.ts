import { app } from 'electron';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from '../fs-safe';
import {
  sanitizeMcpConfig,
  sanitizeMcpConfigWithDiagnostics,
  type McpConfigDiagnostic,
  type McpConfigHealth,
  type McpServerConfig,
  type McpServersFile,
} from '../../shared/mcp';

export function mcpConfigPath(): string {
  return path.join(app.getPath('userData'), 'mcp-servers.json');
}

type McpConfigReadResult = {
  readonly file: McpServersFile;
  readonly health: McpConfigHealth;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fileErrorCode(err: unknown): string | undefined {
  return err && typeof err === 'object' && 'code' in err
    ? String((err as { readonly code?: unknown }).code)
    : undefined;
}

function health(
  exists: boolean,
  diagnostics: readonly McpConfigDiagnostic[],
): McpConfigHealth {
  return {
    path: mcpConfigPath(),
    exists,
    ok: diagnostics.every((d) => d.severity !== 'error'),
    diagnostics,
  };
}

export async function readMcpConfigWithDiagnostics(): Promise<McpConfigReadResult> {
  let raw = '';
  try {
    raw = await fs.readFile(mcpConfigPath(), 'utf8');
  } catch (err) {
    if (fileErrorCode(err) === 'ENOENT') {
      return { file: { servers: [] }, health: health(false, []) };
    }
    const diagnostics: McpConfigDiagnostic[] = [
      {
        severity: 'error',
        code: 'read_error',
        message: `Could not read MCP config: ${errorMessage(err)}`,
      },
    ];
    return { file: { servers: [] }, health: health(true, diagnostics) };
  }

  try {
    const parsed = JSON.parse(raw);
    const { file, diagnostics } = sanitizeMcpConfigWithDiagnostics(parsed);
    return { file, health: health(true, diagnostics) };
  } catch (err) {
    const diagnostics: McpConfigDiagnostic[] = [
      {
        severity: 'error',
        code: 'parse_error',
        message: `MCP config JSON is invalid: ${errorMessage(err)}`,
      },
    ];
    return { file: { servers: [] }, health: health(true, diagnostics) };
  }
}

export async function readMcpConfig(): Promise<McpServersFile> {
  return (await readMcpConfigWithDiagnostics()).file;
}

export function readMcpConfigSync(): McpServersFile {
  try {
    const raw = readFileSync(mcpConfigPath(), 'utf8');
    return sanitizeMcpConfig(JSON.parse(raw));
  } catch {
    return { servers: [] };
  }
}

export async function readMcpConfigHealth(): Promise<McpConfigHealth> {
  return (await readMcpConfigWithDiagnostics()).health;
}

export async function writeMcpConfig(file: McpServersFile): Promise<McpServersFile> {
  const clean = sanitizeMcpConfig(file);
  await atomicWriteFile(mcpConfigPath(), JSON.stringify(clean, null, 2));
  return clean;
}

export async function setMcpServerEnabled(id: string, enabled: boolean): Promise<McpServersFile> {
  const current = await readMcpConfig();
  let changed = false;
  const servers: McpServerConfig[] = current.servers.map((s) => {
    if (s.id !== id) return s;
    changed = true;
    return { ...s, enabled };
  });
  if (!changed) return current;
  return writeMcpConfig({ servers });
}

export type McpServerUpdatePatch = {
  readonly enabled?: boolean;
  readonly trust?: boolean;
  readonly disabledTools?: readonly string[];
  readonly autoApproveTools?: readonly string[];
  readonly confirmTools?: readonly string[];
};

export async function updateMcpServer(
  id: string,
  patch: McpServerUpdatePatch,
): Promise<McpServersFile> {
  const current = await readMcpConfig();
  let changed = false;
  const servers: McpServerConfig[] = current.servers.map((s) => {
    if (s.id !== id) return s;
    changed = true;
    return {
      ...s,
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.trust !== undefined ? { trust: patch.trust } : {}),
      ...(patch.disabledTools !== undefined ? { disabledTools: [...patch.disabledTools] } : {}),
      ...(patch.autoApproveTools !== undefined
        ? { autoApproveTools: [...patch.autoApproveTools] }
        : {}),
      ...(patch.confirmTools !== undefined ? { confirmTools: [...patch.confirmTools] } : {}),
    };
  });
  if (!changed) return current;
  return writeMcpConfig({ servers });
}

export async function removeMcpServer(id: string): Promise<McpServersFile> {
  const current = await readMcpConfig();
  const servers = current.servers.filter((s) => s.id !== id);
  if (servers.length === current.servers.length) return current;
  return writeMcpConfig({ servers });
}

export async function addMcpServer(
  config: McpServerConfig,
): Promise<{ readonly file: McpServersFile; readonly added: boolean }> {
  const current = await readMcpConfig();
  if (current.servers.some((s) => s.id === config.id)) {
    return { file: current, added: false };
  }
  const file = await writeMcpConfig({ servers: [...current.servers, config] });
  return { file, added: true };
}

export async function ensureMcpConfigFile(): Promise<void> {
  const p = mcpConfigPath();
  try {
    await fs.access(p);
  } catch {
    const seed: McpServersFile = { servers: [] };
    await atomicWriteFile(p, JSON.stringify(seed, null, 2)).catch(() => {});
  }
}
