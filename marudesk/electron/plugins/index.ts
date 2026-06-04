import { app } from 'electron';
import path from 'node:path';
import type { PluginCommandSnapshot, PluginStatus } from '../../shared/plugin';
import { ensurePluginsConfigFile } from './config';
import { PluginManager } from './manager';

/**
 * Boot glue for the plugin runtime (docs/plugin-runtime-design.md §7 P1) — the
 * analogue of agent/mcp-handlers.ts for external MCP. Owns the singleton
 * {@link PluginManager}, seeds the config file, scans + reconciles on startup, and
 * tears workers down on quit. Ships inert: with no approved config the scan finds
 * plugins but activates nothing (a plugin is only spawned once enabled + granted
 * in Settings, P2).
 */

let manager: PluginManager | null = null;
let initialized = false;

/** Scan the user/project plugin folders and activate any approved plugins. */
export async function initPlugins(getWorkspaceRoot: () => string | null): Promise<void> {
  if (initialized) return;
  initialized = true;
  manager = new PluginManager({
    userDir: path.join(app.getPath('userData'), 'plugins'),
    getWorkspaceRoot,
  });
  await ensurePluginsConfigFile();
  await manager.reload();
}

/** Re-scan + reconcile (Settings "Reload", or after an enable/grant change). */
export async function reloadPlugins(): Promise<PluginStatus[]> {
  return manager ? manager.reload() : [];
}

/** Latest per-plugin statuses (cheap; no scan). */
export function listPluginStatuses(): PluginStatus[] {
  return manager ? manager.list() : [];
}

/** Enable/disable one plugin (Settings toggle); re-reconciles and returns statuses. */
export async function setPluginEnabled(id: string, enabled: boolean): Promise<PluginStatus[]> {
  return manager ? manager.setEnabled(id, enabled) : [];
}

/** Slash commands contributed by active plugins (for the composer menu). */
export function listPluginCommands(): PluginCommandSnapshot[] {
  return manager ? manager.listCommands() : [];
}

/** Tear down every plugin worker (before-quit). */
export function shutdownPlugins(): void {
  manager?.dispose();
}
