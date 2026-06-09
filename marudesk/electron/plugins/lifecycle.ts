import fs from 'node:fs/promises';
import path from 'node:path';
import { isValidPluginId } from '../../shared/plugin';
import { readPluginManifest } from './manifest';

const MAX_PLUGIN_INSTALL_FILES = 2_000;

function userPluginTarget(userDir: string, pluginId: string): string {
  if (!isValidPluginId(pluginId)) throw new Error('invalid plugin id');
  const root = path.resolve(userDir);
  const target = path.resolve(root, pluginId);
  if (target === root || !target.startsWith(root + path.sep)) {
    throw new Error('plugin path escapes the user plugin directory');
  }
  return target;
}

async function rejectSymlinks(root: string): Promise<void> {
  let count = 0;

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      count += 1;
      if (count > MAX_PLUGIN_INSTALL_FILES) throw new Error('plugin folder is too large');
      if (entry.isSymbolicLink()) throw new Error('plugin folder must not contain symlinks');
      if (entry.isDirectory()) await walk(path.join(dir, entry.name));
    }
  }

  await walk(root);
}

/** Copy a valid plugin folder into the user plugin directory. */
export async function installUserPluginFolder(userDir: string, sourceDir: string): Promise<string> {
  const sourceReal = await fs.realpath(sourceDir);
  const manifest = await readPluginManifest(sourceReal);
  if (!manifest) throw new Error('selected folder is not a valid plugin');
  await rejectSymlinks(sourceReal);
  await fs.mkdir(userDir, { recursive: true });
  const targetDir = userPluginTarget(userDir, manifest.id);
  const targetStat = await fs.lstat(targetDir).catch(() => null);
  if (targetStat) throw new Error(`plugin "${manifest.id}" is already installed`);
  await fs.cp(sourceReal, targetDir, { recursive: true, errorOnExist: true, force: false });
  return manifest.id;
}

/** Remove one user-scoped plugin folder by id. */
export async function removeUserPluginFolder(userDir: string, pluginId: string): Promise<boolean> {
  const targetDir = userPluginTarget(userDir, pluginId);
  const targetStat = await fs.lstat(targetDir).catch(() => null);
  if (!targetStat) return false;
  if (!targetStat.isDirectory()) throw new Error('plugin install target is not a directory');
  await fs.rm(targetDir, { recursive: true, force: false, maxRetries: 10, retryDelay: 100 });
  return true;
}

export async function hasUserPluginFolder(userDir: string, pluginId: string): Promise<boolean> {
  const targetDir = userPluginTarget(userDir, pluginId);
  const targetStat = await fs.lstat(targetDir).catch(() => null);
  return targetStat?.isDirectory() === true;
}
