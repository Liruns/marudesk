import fs from 'node:fs/promises';
import path from 'node:path';
import fsSync from 'node:fs';
import {
  isSafePanelPath,
  isValidPluginId,
  permissionsKey,
  PLUGIN_PERMISSIONS,
  PLUGIN_SERVER_PREFIX,
  pluginToolName,
  type PluginCommandSnapshot,
  type PluginManifest,
  type PluginPanel,
  type PluginPermission,
  type PluginSlashContribution,
  type PluginStatus,
} from '../../shared/plugin';
import { registerMcpServer, unregisterMcpServer } from '../agent/mcp';
import { buildPluginServer, PluginHost } from './host';
import { readPluginsConfig, setPluginConfig } from './config';
import { spawnViaUtilityProcess } from './spawn-electron';
import type { SpawnWorker } from './transport';

/**
 * Plugin manager (docs/plugin-runtime-design.md §1, §7 P1). Scans the user and
 * project plugin folders, reconciles each discovered plugin against the persisted
 * enable/grant config, and — for an enabled plugin whose declared permissions are
 * all granted and unchanged — spawns its isolated worker, loads it, and registers
 * its contributed tools through {@link registerMcpServer} (the same merge point the
 * built-in and external-MCP servers use, so the loop mediates a plugin tool exactly
 * like a built-in one). Everything is best-effort: a bad manifest / failed load is
 * recorded as an `error` status and skipped, never crashing the app.
 *
 * Ships inert: with no config the scan finds plugins but activates nothing until
 * the user approves one in Settings (P2).
 */

type Discovered = { scope: 'user' | 'project'; dir: string; manifest: PluginManifest };

type LivePlugin = {
  host: PluginHost;
  status: PluginStatus;
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

const MAX_PLUGINS = 100;

/** Read + validate one plugin folder's manifest. Returns null if unusable. */
async function readManifest(dir: string): Promise<PluginManifest | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, 'manifest.json'), 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const m = parsed as Record<string, unknown>;
  const folder = path.basename(dir);
  if (!isValidPluginId(m.id) || m.id !== folder) return null;
  if (typeof m.main !== 'string' || m.main.length === 0) return null;
  // main must not escape the plugin folder.
  const entry = path.resolve(dir, m.main);
  if (!entry.startsWith(path.resolve(dir) + path.sep)) return null;
  const allowed = new Set<string>(PLUGIN_PERMISSIONS);
  const permissions = Array.isArray(m.permissions)
    ? m.permissions.filter((p): p is PluginPermission => typeof p === 'string' && allowed.has(p))
    : [];
  return {
    id: m.id,
    name: typeof m.name === 'string' ? m.name : m.id,
    version: typeof m.version === 'string' ? m.version : '0.0.0',
    description: typeof m.description === 'string' ? m.description : undefined,
    main: m.main,
    permissions,
    ...(m.net && typeof m.net === 'object' ? { net: m.net as PluginManifest['net'] } : {}),
    ...(parsePanel(m.panel) ? { panel: parsePanel(m.panel)! } : {}),
  };
}

/** Validate a manifest `panel` block: a string title + a safe folder-relative entry. */
function parsePanel(value: unknown): PluginPanel | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as { title?: unknown; entry?: unknown };
  if (typeof p.title !== 'string' || !isSafePanelPath(p.entry)) return null;
  return { title: p.title.slice(0, 120), entry: p.entry };
}

async function scanDir(dir: string, scope: 'user' | 'project'): Promise<Discovered[]> {
  let entries: string[];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const out: Discovered[] = [];
  for (const name of entries.slice(0, MAX_PLUGINS)) {
    const pluginDir = path.join(dir, name);
    const manifest = await readManifest(pluginDir);
    if (manifest) out.push({ scope, dir: pluginDir, manifest });
  }
  return out;
}

export class PluginManager {
  private readonly deps: PluginManagerDeps;
  private readonly spawn: SpawnWorker;
  private readonly live = new Map<string, LivePlugin>();
  private statuses: PluginStatus[] = [];

  constructor(deps: PluginManagerDeps) {
    this.deps = deps;
    this.spawn = deps.spawn ?? spawnViaUtilityProcess;
  }

  /** Discover plugins across user + project scope; project shadows user by id. */
  private async discover(): Promise<Map<string, Discovered>> {
    const userPlugins = await scanDir(this.deps.userDir, 'user');
    const root = this.deps.getWorkspaceRoot();
    const projectPlugins = root
      ? await scanDir(path.join(root, '.marudesk', 'plugins'), 'project')
      : [];
    const byId = new Map<string, Discovered>();
    for (const d of userPlugins) byId.set(d.manifest.id, d);
    for (const d of projectPlugins) byId.set(d.manifest.id, d); // project wins
    return byId;
  }

  /** (Re)scan + reconcile with the persisted config. Returns fresh statuses. */
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

  /** Spawn + load one plugin and register its tools. Idempotent per reload. */
  private async activate(d: Discovered, granted: PluginPermission[]): Promise<PluginStatus> {
    // Replace any prior instance so a reload re-reads code/manifest cleanly.
    this.deactivate(d.manifest.id);
    const base = {
      id: d.manifest.id,
      name: d.manifest.name,
      version: d.manifest.version,
      scope: d.scope,
      permissions: d.manifest.permissions ?? [],
      granted,
    };
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
        status,
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

  /** Tear down a live plugin: unregister its server and dispose the worker. */
  private deactivate(id: string): void {
    const existing = this.live.get(id);
    if (!existing) return;
    unregisterMcpServer(`${PLUGIN_SERVER_PREFIX}${id}`);
    existing.host.dispose();
    this.live.delete(id);
  }

  /** Latest per-plugin statuses (cheap; no scan). */
  list(): PluginStatus[] {
    return this.statuses;
  }

  /**
   * Resolve a `plugin://<id>/<relPath>` request to an absolute file, or null
   * (v2 §8.5). Serves ONLY an active plugin that holds the `ui` grant + declares a
   * panel, only paths inside its folder (no `..`, symlink realpath re-checked).
   */
  resolvePanelFile(pluginId: string, relPath: string): string | null {
    const live = this.live.get(pluginId);
    if (!live || !live.panel) return null; // not active / no ui panel
    if (!isSafePanelPath(relPath)) return null;
    const root = path.resolve(live.dir);
    const abs = path.resolve(root, relPath);
    if (abs !== root && !abs.startsWith(root + path.sep)) return null;
    try {
      const real = fsSync.realpathSync(abs);
      if (real !== root && !real.startsWith(root + path.sep)) return null;
      if (!fsSync.statSync(real).isFile()) return null;
      return real;
    } catch {
      return null;
    }
  }

  /** Slash commands contributed by currently-active plugins (for the composer). */
  listCommands(): PluginCommandSnapshot[] {
    const out: PluginCommandSnapshot[] = [];
    for (const [id, live] of this.live) {
      for (const c of live.commands) out.push({ ...c, pluginId: id });
    }
    return out;
  }

  /**
   * Enable or disable one plugin and re-reconcile. Enabling a plugin records its
   * declared permissions as granted (the toggle IS the approval — the card shows
   * what is being granted) and stamps the approved-permissions key so a later
   * manifest permission change forces re-approval (state → needs-approval).
   * Disabling keeps the prior grant so re-enabling doesn't re-prompt.
   */
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

  /** Tear down everything (before-quit). */
  dispose(): void {
    for (const id of [...this.live.keys()]) this.deactivate(id);
    this.statuses = [];
  }
}
