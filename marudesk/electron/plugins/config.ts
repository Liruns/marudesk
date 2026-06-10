import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from '../fs-safe';
import {
  isValidPluginId,
  PLUGIN_PERMISSIONS,
  type PluginConfigEntry,
  type PluginPermission,
  type PluginsConfigFile,
} from '../../shared/plugin';

/**
 * Config store for the plugin runtime (docs/plugin-runtime-design.md §config).
 * Persisted as `userData/plugins.json`: per-plugin `enabled` + the `granted`
 * permission set the user approved + a hash of the approved permission set (to
 * detect a manifest permission change → re-approval). The file is untrusted, so
 * every read is sanitized; a malformed entry is dropped, never crashes the app.
 *
 * Default is EMPTY → the runtime ships inert: nothing is enabled or granted until
 * the user approves a plugin in Settings (P2). We never activate anything not
 * recorded here as enabled with its declared permissions granted.
 */

export function pluginsConfigPath(): string {
  return path.join(app.getPath('userData'), 'plugins.json');
}

function sanitizePermissions(value: unknown): PluginPermission[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set<string>(PLUGIN_PERMISSIONS);
  const out: PluginPermission[] = [];
  for (const p of value) {
    if (typeof p === 'string' && allowed.has(p) && !out.includes(p as PluginPermission)) {
      out.push(p as PluginPermission);
    }
  }
  return out;
}

function sanitize(value: unknown): PluginsConfigFile {
  const raw = (value as { plugins?: unknown })?.plugins;
  if (!Array.isArray(raw)) return { plugins: [] };
  const seen = new Set<string>();
  const plugins: PluginConfigEntry[] = [];
  for (const entry of raw) {
    const e = entry as Record<string, unknown>;
    if (!isValidPluginId(e?.id) || seen.has(e.id as string)) continue;
    seen.add(e.id as string);
    plugins.push({
      id: e.id as string,
      enabled: e.enabled === true,
      granted: sanitizePermissions(e.granted),
      ...(typeof e.approvedPermissionsKey === 'string'
        ? { approvedPermissionsKey: e.approvedPermissionsKey }
        : {}),
    });
  }
  return { plugins };
}

export async function readPluginsConfig(): Promise<PluginsConfigFile> {
  try {
    const raw = await fs.readFile(pluginsConfigPath(), 'utf8');
    return sanitize(JSON.parse(raw));
  } catch {
    return { plugins: [] };
  }
}

export async function writePluginsConfig(file: PluginsConfigFile): Promise<PluginsConfigFile> {
  const clean = sanitize(file);
  await atomicWriteFile(pluginsConfigPath(), JSON.stringify(clean, null, 2));
  return clean;
}

/** Upsert one plugin's config entry (used by the Settings enable/grant flow, P2). */
export async function setPluginConfig(entry: PluginConfigEntry): Promise<PluginsConfigFile> {
  const current = await readPluginsConfig();
  const plugins = current.plugins.filter((p) => p.id !== entry.id);
  plugins.push(entry);
  return writePluginsConfig({ plugins });
}

export async function removePluginConfig(id: string): Promise<PluginsConfigFile> {
  const current = await readPluginsConfig();
  return writePluginsConfig({ plugins: current.plugins.filter((p) => p.id !== id) });
}

export async function ensurePluginsConfigFile(): Promise<void> {
  const p = pluginsConfigPath();
  try {
    await fs.access(p);
  } catch {
    await atomicWriteFile(p, JSON.stringify({ plugins: [] }, null, 2)).catch(() => {});
  }
}
