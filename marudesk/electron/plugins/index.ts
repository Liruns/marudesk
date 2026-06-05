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
let userPluginsDir: string | null = null;

/** Scan the user/project plugin folders and activate any approved plugins. */
export async function initPlugins(getWorkspaceRoot: () => string | null): Promise<void> {
  if (initialized) return;
  initialized = true;
  userPluginsDir = path.join(app.getPath('userData'), 'plugins');
  manager = new PluginManager({
    userDir: userPluginsDir,
    getWorkspaceRoot,
  });
  await ensurePluginsConfigFile();
  await manager.reload();
}

/** User-level plugin install folder: `<userData>/plugins`. */
export function getUserPluginsDir(): string {
  return userPluginsDir ?? path.join(app.getPath('userData'), 'plugins');
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

/** Resolve a `plugin://<id>/<path>` panel request to an absolute file (or null). */
export function resolvePluginPanelFile(pluginId: string, relPath: string): string | null {
  return manager ? manager.resolvePanelFile(pluginId, relPath) : null;
}

/** Tear down every plugin worker (before-quit). */
export function shutdownPlugins(): void {
  manager?.dispose();
}
