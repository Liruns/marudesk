import { shell } from 'electron';
import type { McpServerStatus } from '../../shared/mcp';
import { defineHandler } from '../ipc/define-handler';
import { bool, nonEmptyStr, obj } from '../ipc/validate';
import { findMcpPreset } from '../../shared/mcp-presets';
import {
  addMcpServer,
  ensureMcpConfigFile,
  mcpConfigPath,
  readMcpConfig,
  setMcpServerEnabled,
} from './mcp-config';
import {
  disposeExternalMcpServers,
  listMcpServerStatuses,
  syncExternalMcpServers,
} from './mcp-external';
import { embeddedBrowserDebugStatus } from './embedded-browser';

/**
 * Glue between the external-MCP config store (mcp-config.ts) and the connector
 * manager (mcp-external.ts): reconcile the live connections with the persisted
 * config, expose the Settings IPC, and wire startup/quit lifecycle.
 *
 * Loop mediation is preserved end to end — the manager registers each external
 * tool as a plain in-process tool whose `exec` calls the MCP client itself, so the
 * loop approves / read-only-gates / ask_user-parks it exactly like a built-in tool.
 */

let initialized = false;

/**
 * (Re)connect the manager to whatever is in the config file. Safe to call
 * repeatedly (sync is idempotent — it only (dis)connects what changed). Returns the
 * fresh per-server statuses.
 */
export async function reloadExternalMcp(): Promise<McpServerStatus[]> {
  const { servers } = await readMcpConfig();
  return syncExternalMcpServers(servers);
}

/**
 * Initialize external MCP at startup (after settings load, from main.ts). Seeds the
 * config file if absent, then connects enabled servers. Fire-and-forget friendly:
 * a per-server failure is handled inside the manager and never throws here.
 */
export async function initExternalMcp(): Promise<void> {
  if (initialized) return;
  initialized = true;
  await ensureMcpConfigFile();
  await reloadExternalMcp();
}

/** Tear down every external connection (before-quit). */
export async function shutdownExternalMcp(): Promise<void> {
  await disposeExternalMcpServers();
}

/** IPC for Settings → MCP Servers (list status, reload, enable/disable, open config). */
export function registerMcpHandlers(): void {
  // Current per-server status (connected / disabled / error + tool count). Cheap —
  // reads the manager's in-memory status map, no spawning.
  defineHandler('mcp:list-servers', () => listMcpServerStatuses());

  // Re-read the config file and reconcile connections (the "Reload" action — also
  // how a hand-edit of the JSON is picked up). Returns the fresh statuses.
  defineHandler('mcp:reload', () => reloadExternalMcp());

  // Flip one server's enabled flag, persist, and reconnect/disconnect it.
  defineHandler('mcp:set-enabled', async ([payload]) => {
    const o = obj(payload);
    const id = nonEmptyStr(o.id, 'id');
    const enabled = bool(o.enabled, 'enabled');
    await setMcpServerEnabled(id, enabled);
    return reloadExternalMcp();
  });

  // Add a curated preset server (e.g. Chrome DevTools browser control) to the config
  // and connect it. No-op if its id is already configured. Returns fresh statuses.
  defineHandler('mcp:add-preset', async ([payload]) => {
    const o = obj(payload);
    const id = nonEmptyStr(o.id, 'id');
    const preset = findMcpPreset(id);
    if (!preset) throw new Error(`unknown MCP preset: ${id}`);
    await addMcpServer(preset.config);
    return reloadExternalMcp();
  });

  // Whether the browser-control preset drives the embedded Chromium, and whether the
  // remote-debugging port it attaches to was opened this launch — lets Settings show
  // a "restart to apply" hint right after the preset is added (the switch is boot-only).
  defineHandler('mcp:embedded-browser-status', () => embeddedBrowserDebugStatus());

  // Reveal the config file in the OS so the user can hand-edit it (Claude-Desktop
  // style). Ensures it exists first so there's a real file to open.
  defineHandler('mcp:open-config', async () => {
    await ensureMcpConfigFile();
    // openPath opens it in the default editor; reveal-on-failure is acceptable.
    const err = await shell.openPath(mcpConfigPath());
    if (err) shell.showItemInFolder(mcpConfigPath());
    return { path: mcpConfigPath() };
  });
}
