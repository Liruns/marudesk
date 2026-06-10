import {
  permissionsKey,
  PLUGIN_SERVER_PREFIX,
  pluginToolName,
  type PluginCommandSnapshot,
  type PluginPanel,
  type PluginPermission,
  type PluginSlashContribution,
  type PluginStatus,
} from '../../shared/plugin';
import { appVersion } from './app-version';
import { discoverPlugins, type DiscoveredPlugin } from './discovery';
import { registerMcpServer, unregisterMcpServer } from '../agent/mcp';
import { satisfiesEngine } from './engine-compat';
import { buildPluginServer, PluginHost } from './host';
import { readPluginsConfig, removePluginConfig, setPluginConfig } from './config';
import { hasUserPluginFolder, installUserPluginFolder, removeUserPluginFolder } from './lifecycle';
import { readPluginManifest } from './manifest';
import { resolvePanelFile } from './panel-resolver';
import { spawnViaUtilityProcess } from './spawn-electron';
import type { SpawnWorker } from './transport';

type LivePlugin = {
  host: PluginHost;
  commands: PluginSlashContribution[];
  /** Absolute plugin folder + its panel, when active with the `ui` grant (v2). */
  dir: string;
  panel?: PluginPanel;
};

export type PluginManagerDeps = {
  /** `<userData>/plugins`. */
  userDir: string;
  /** Current workspace root, for `<root>/.marudesk/plugins`; null when none open. */
  getWorkspaceRoot: () => string | null;
  /** Spawn backend; defaults to utilityProcess (overridable for tests). */
  spawn?: SpawnWorker;
};

export class PluginManager {
  private readonly deps: PluginManagerDeps;
  private readonly spawn: SpawnWorker;
  private readonly live = new Map<string, LivePlugin>();
  private statuses: PluginStatus[] = [];

  constructor(deps: PluginManagerDeps) {
    this.deps = deps;
    this.spawn = deps.spawn ?? spawnViaUtilityProcess;
  }

  // Discover plugins across user + project scope; project shadows user by id.
  private discover(): Promise<Map<string, DiscoveredPlugin>> {
    return discoverPlugins(this.deps.userDir, this.deps.getWorkspaceRoot);
  }

  // Re-scan and reconcile with persisted config.
  async reload(): Promise<PluginStatus[]> {
    const discovered = await this.discover();
    const config = await readPluginsConfig();
    const next: PluginStatus[] = [];
    const keepIds = new Set<string>();

    for (const [id, d] of discovered) {
      const entry = config.plugins.find((p) => p.id === id);
      const declared = d.manifest.permissions ?? [];
      const granted = entry?.granted ?? [];
      const approvedCurrent =
        entry?.approvedPermissionsKey === permissionsKey(declared) &&
        declared.every((p) => granted.includes(p));
      const enabled = entry?.enabled === true;

      if (enabled && approvedCurrent) {
        keepIds.add(id);
        const status = await this.activate(d, granted);
        next.push(status);
      } else {
        this.deactivate(id);
        next.push({
          id,
          name: d.manifest.name,
          version: d.manifest.version,
          scope: d.scope,
          ...(d.hasUserInstall ? { hasUserInstall: true } : {}),
          state: enabled ? 'needs-approval' : 'disabled',
          permissions: declared,
          granted,
          toolNames: [],
          commandNames: [],
        });
      }
    }

    // Tear down any live plugin that vanished from disk.
    for (const id of [...this.live.keys()]) {
      if (!keepIds.has(id)) this.deactivate(id);
    }

    this.statuses = next;
    return next;
  }

  // Spawn and load one plugin. Idempotent per reload.
  private async activate(d: DiscoveredPlugin, granted: PluginPermission[]): Promise<PluginStatus> {
    // Replace any prior instance so a reload re-reads code/manifest cleanly.
    this.deactivate(d.manifest.id);
    const base = {
      id: d.manifest.id,
      name: d.manifest.name,
      version: d.manifest.version,
      scope: d.scope,
      ...(d.hasUserInstall ? { hasUserInstall: true } : {}),
      permissions: d.manifest.permissions ?? [],
      granted,
    };
    // Engine compat gate (audit H9): refuse to load a plugin built against an
    // incompatible host API instead of activating it and hoping for the best.
    const required = d.manifest.engine?.marudesk;
    if (required && !satisfiesEngine(appVersion(), required)) {
      return {
        ...base,
        state: 'error',
        toolNames: [],
        commandNames: [],
        error: `requires marudesk ${required} (running ${appVersion()})`,
      };
    }
    try {
      const { channel } = this.spawn({ workerEntry: '', pluginDir: d.dir, granted });
      const host = new PluginHost(channel, d.manifest.id);
      const netAllow = d.manifest.net?.allow ?? [];
      const contributions = await host.load(d.dir, d.manifest.main, granted, netAllow);
      registerMcpServer(buildPluginServer(d.manifest.id, host, contributions));
      // A panel is only exposed when the plugin declares one AND holds the `ui` grant.
      const panel = d.manifest.panel && granted.includes('ui') ? d.manifest.panel : undefined;
      const status: PluginStatus = {
        ...base,
        state: 'active',
        toolNames: contributions.tools.map((t) => pluginToolName(d.manifest.id, t.name)),
        commandNames: contributions.commands.map((c) => c.name),
        ...(panel ? { panel } : {}),
      };
      this.live.set(d.manifest.id, {
        host,
        commands: contributions.commands,
        dir: d.dir,
        panel,
      });
      return status;
    } catch (err) {
      this.deactivate(d.manifest.id);
      return {
        ...base,
        state: 'error',
        toolNames: [],
        commandNames: [],
        error: (err as Error).message,
      };
    }
  }

  // Tear down a live plugin: unregister its server and dispose the worker.
  private deactivate(id: string): void {
    const existing = this.live.get(id);
    if (!existing) return;
    unregisterMcpServer(`${PLUGIN_SERVER_PREFIX}${id}`);
    existing.host.dispose();
    this.live.delete(id);
  }

  // Latest per-plugin statuses (cheap; no scan).
  list(): PluginStatus[] {
    return this.statuses;
  }

  // Resolve a plugin panel request to an absolute file, or null.
  resolvePanelFile(pluginId: string, relPath: string): string | null {
    return resolvePanelFile(this.live.get(pluginId), relPath);
  }

  // Slash commands contributed by currently-active plugins.
  listCommands(): PluginCommandSnapshot[] {
    const out: PluginCommandSnapshot[] = [];
    for (const [id, live] of this.live) {
      for (const c of live.commands) out.push({ ...c, pluginId: id });
    }
    return out;
  }

  // Enable/disable one plugin; enabling records declared permissions as approved.
  async setEnabled(id: string, enabled: boolean): Promise<PluginStatus[]> {
    const discovered = await this.discover();
    const found = discovered.get(id);
    if (!found) return this.reload();
    const declared = found.manifest.permissions ?? [];
    const config = await readPluginsConfig();
    const prior = config.plugins.find((p) => p.id === id);
    await setPluginConfig(
      enabled
        ? { id, enabled: true, granted: declared, approvedPermissionsKey: permissionsKey(declared) }
        : {
            id,
            enabled: false,
            granted: prior?.granted ?? [],
            ...(prior?.approvedPermissionsKey
              ? { approvedPermissionsKey: prior.approvedPermissionsKey }
              : {}),
          },
    );
    return this.reload();
  }

  // Install a user plugin from an arbitrary folder, then rescan.
  async installFromFolder(sourceDir: string): Promise<PluginStatus[]> {
    const manifest = await readPluginManifest(sourceDir);
    if (!manifest) throw new Error('selected folder is not a valid plugin');
    const existing = (await this.discover()).get(manifest.id);
    if (existing?.scope === 'project') {
      throw new Error(`plugin "${manifest.id}" already exists as a project plugin`);
    }
    await installUserPluginFolder(this.deps.userDir, sourceDir);
    return this.reload();
  }

  // Remove a discovered user-scoped plugin and forget its saved config.
  async remove(id: string): Promise<PluginStatus[]> {
    const discovered = await this.discover();
    const found = discovered.get(id);
    if (!found) return this.reload();
    if (found.scope !== 'user') {
      if (!found.hasUserInstall || !(await hasUserPluginFolder(this.deps.userDir, id))) {
        throw new Error('only user plugins can be removed');
      }
      await removeUserPluginFolder(this.deps.userDir, id);
      await removePluginConfig(id);
      return this.reload();
    }
    this.deactivate(id);
    await removeUserPluginFolder(this.deps.userDir, id);
    await removePluginConfig(id);
    return this.reload();
  }

  // Tear down everything before quit or harness reset.
  dispose(): void {
    for (const id of [...this.live.keys()]) this.deactivate(id);
    this.statuses = [];
  }
}
