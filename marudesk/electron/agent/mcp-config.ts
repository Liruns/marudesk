import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from '../fs-safe';
import {
  sanitizeMcpConfig,
  type McpServerConfig,
  type McpServersFile,
} from '../../shared/mcp';

/**
 * Config store for external (stdio) MCP connectors (docs/remote-mobile-bridge-design
 * §M3). Persisted as `userData/mcp-servers.json` in the Claude-Desktop style — a
 * plain, hand-editable list of `{ id, command, args?, env?, enabled }`. The file is
 * untrusted (the user edits it, or it's read off disk), so every read goes through
 * {@link sanitizeMcpConfig}: a malformed entry is dropped, never crashes the app.
 *
 * Default is EMPTY (no servers) — so M3 ships inert: nothing is spawned until the
 * user adds a server. We never spawn anything not in this file.
 */

/** Absolute path to the config file (also shown in Settings for hand-editing). */
export function mcpConfigPath(): string {
  return path.join(app.getPath('userData'), 'mcp-servers.json');
}

/** Read + sanitize the configured servers. Missing/corrupt file → empty list. */
export async function readMcpConfig(): Promise<McpServersFile> {
  try {
    const raw = await fs.readFile(mcpConfigPath(), 'utf8');
    return sanitizeMcpConfig(JSON.parse(raw));
  } catch {
    // Missing or unreadable/corrupt — treat as no servers configured.
    return { servers: [] };
  }
}

/**
 * Write the config back (atomic tmp+rename). Sanitized first so a programmatic
 * write can't persist an invalid shape. Used by the Settings enable/disable toggle
 * and (later) an add form.
 */
export async function writeMcpConfig(file: McpServersFile): Promise<McpServersFile> {
  const clean = sanitizeMcpConfig(file);
  await atomicWriteFile(mcpConfigPath(), JSON.stringify(clean, null, 2));
  return clean;
}

/**
 * Toggle one server's `enabled` flag and persist. Returns the updated config (or
 * the unchanged config when the id is unknown). The caller re-syncs the manager.
 */
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

/**
 * Add a server config (e.g. from a preset) if its id isn't already present, and
 * persist. Returns the resulting config plus whether anything was added — an existing
 * id is left untouched (the caller surfaces "already added"). Re-sanitized on write.
 */
export async function addMcpServer(
  config: McpServerConfig,
): Promise<{ file: McpServersFile; added: boolean }> {
  const current = await readMcpConfig();
  if (current.servers.some((s) => s.id === config.id)) {
    return { file: current, added: false };
  }
  const file = await writeMcpConfig({ servers: [...current.servers, config] });
  return { file, added: true };
}

/**
 * Ensure the config file exists on disk (seeded with an empty, commented-by-example
 * shape) so "open config" reveals a real, editable file rather than a missing one.
 * Best-effort — a failure just means the file is created on the next write.
 */
export async function ensureMcpConfigFile(): Promise<void> {
  const p = mcpConfigPath();
  try {
    await fs.access(p);
  } catch {
    // Seed with an empty servers list. A user pastes their Claude-Desktop-style
    // entries here; nothing is spawned until they add one and enable it.
    const seed: McpServersFile = { servers: [] };
    await atomicWriteFile(p, JSON.stringify(seed, null, 2)).catch(() => {});
  }
}
