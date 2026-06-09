import fs from 'node:fs/promises';
import path from 'node:path';
import type { PluginManifest } from '../../shared/plugin';
import { readPluginManifest } from './manifest';

const MAX_PLUGINS = 100;

export type DiscoveredPlugin = {
  scope: 'user' | 'project';
  dir: string;
  manifest: PluginManifest;
  hasUserInstall?: boolean;
};

async function scanDir(dir: string, scope: 'user' | 'project'): Promise<DiscoveredPlugin[]> {
  let entries: string[];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const discovered: DiscoveredPlugin[] = [];
  for (const name of entries.slice(0, MAX_PLUGINS)) {
    const pluginDir = path.join(dir, name);
    const manifest = await readPluginManifest(pluginDir);
    if (manifest) discovered.push({ scope, dir: pluginDir, manifest });
  }
  return discovered;
}

export async function discoverPlugins(
  userDir: string,
  getWorkspaceRoot: () => string | null,
): Promise<Map<string, DiscoveredPlugin>> {
  const userPlugins = await scanDir(userDir, 'user');
  const root = getWorkspaceRoot();
  const projectPlugins = root
    ? await scanDir(path.join(root, '.marudesk', 'plugins'), 'project')
    : [];
  const byId = new Map<string, DiscoveredPlugin>();
  for (const plugin of userPlugins) byId.set(plugin.manifest.id, plugin);
  for (const plugin of projectPlugins) {
    const existing = byId.get(plugin.manifest.id);
    byId.set(plugin.manifest.id, {
      ...plugin,
      ...(existing?.scope === 'user' ? { hasUserInstall: true } : {}),
    });
  }
  return byId;
}
