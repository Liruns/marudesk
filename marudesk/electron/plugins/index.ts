import { app } from 'electron';
import path from 'node:path';
import type {
  PluginCommandSnapshot,
  PluginSessionPhase,
  PluginStatus,
} from '../../shared/plugin';
import { ensurePluginsConfigFile } from './config';
import { PluginManager } from './manager';
import type { PluginStatusUpdate } from './host';
import { setSessionLifecycleNotifier } from '../agent/loop-sessions.ts';
import type { SpawnWorker } from './transport';

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

export type InitPluginsDeps = {
  userDir?: string;
  spawn?: SpawnWorker;
  /**
   * Sink for plugin `ctx.setStatus` updates. The worker→host pipe is complete and
   * host-side scrubbed; production (main.ts) does NOT yet pass a sink, so a status
   * push is an intentional no-op until a renderer HUD subscribes — same
   * "not-yet-surfaced" posture as `agent:handoff` / `agent:runtime-snapshot`. Wire
   * a renderer subscriber here when the status UI lands.
   */
  onStatus?: (update: PluginStatusUpdate) => void;
};

/** Scan the user/project plugin folders and activate any approved plugins. */
export async function initPlugins(
  getWorkspaceRoot: () => string | null,
  deps: InitPluginsDeps = {},
): Promise<void> {
  if (initialized) return;
  initialized = true;
  userPluginsDir = deps.userDir ?? path.join(app.getPath('userData'), 'plugins');
  manager = new PluginManager({
    userDir: userPluginsDir,
    getWorkspaceRoot,
    ...(deps.spawn ? { spawn: deps.spawn } : {}),
    ...(deps.onStatus ? { onStatus: deps.onStatus } : {}),
  });
  // Bridge the agent loop's conversation lifecycle to live plugins (item:
  // onSession), so a stateful plugin can reset per-conversation state.
  setSessionLifecycleNotifier((phase: PluginSessionPhase, sessionId: string) => {
    manager?.notifySession(phase, sessionId);
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

/** Install a user-scoped plugin from a chosen folder. */
export async function installPluginFolder(sourceDir: string): Promise<PluginStatus[]> {
  return manager ? manager.installFromFolder(sourceDir) : [];
}

/** Remove one installed user-scoped plugin by id. */
export async function removePlugin(id: string): Promise<PluginStatus[]> {
  return manager ? manager.remove(id) : [];
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
  setSessionLifecycleNotifier(null);
  manager?.dispose();
  manager = null;
  initialized = false;
  userPluginsDir = null;
}
