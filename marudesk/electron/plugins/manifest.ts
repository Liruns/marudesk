import fs from 'node:fs/promises';
import path from 'node:path';
import {
  isSafePanelPath,
  isValidPluginId,
  PLUGIN_PERMISSIONS,
  type PluginManifest,
  type PluginPanel,
  type PluginPermission,
} from '../../shared/plugin';

type PluginNet = NonNullable<PluginManifest['net']>;

/** Read + validate one plugin folder's manifest. Returns null if unusable. */
export async function readPluginManifest(dir: string): Promise<PluginManifest | null> {
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
  if (!isRecord(parsed)) return null;
  const m = parsed;
  const folder = path.basename(dir);
  if (!isValidPluginId(m.id) || m.id !== folder) return null;
  if (typeof m.main !== 'string' || m.main.length === 0) return null;
  const entry = path.resolve(dir, m.main);
  if (!entry.startsWith(path.resolve(dir) + path.sep)) return null;
  const allowed = new Set<string>(PLUGIN_PERMISSIONS);
  const permissions = Array.isArray(m.permissions)
    ? m.permissions.filter((p): p is PluginPermission => typeof p === 'string' && allowed.has(p))
    : [];
  const panel = parsePanel(m.panel);
  const engine = parseEngine(m.engine);
  const net = parseNet(m.net);
  return {
    id: m.id,
    name: typeof m.name === 'string' ? m.name : m.id,
    version: typeof m.version === 'string' ? m.version : '0.0.0',
    description: typeof m.description === 'string' ? m.description : undefined,
    main: m.main,
    permissions,
    ...(net ? { net } : {}),
    ...(panel ? { panel } : {}),
    ...(engine ? { engine } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Validate a manifest `engine` block: `{ marudesk?: "<semver range>" }`. */
function parseEngine(value: unknown): { marudesk?: string } | null {
  if (!isRecord(value)) return null;
  if (typeof value.marudesk !== 'string' || !value.marudesk.trim()) return null;
  return { marudesk: value.marudesk.trim() };
}

function parseNet(value: unknown): PluginNet | null {
  if (!isRecord(value)) return null;
  const allow = Array.isArray(value.allow)
    ? value.allow.filter((host): host is string => typeof host === 'string' && host.trim().length > 0)
    : [];
  return { allow: allow.map((host) => host.trim()).slice(0, 100) };
}

/** Validate a manifest `panel` block: a string title + a safe folder-relative entry. */
function parsePanel(value: unknown): PluginPanel | null {
  if (!isRecord(value)) return null;
  if (typeof value.title !== 'string' || !isSafePanelPath(value.entry)) return null;
  return { title: value.title.slice(0, 120), entry: value.entry };
}
