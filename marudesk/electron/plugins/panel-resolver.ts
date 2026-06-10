import fs from 'node:fs';
import path from 'node:path';
import { isSafePanelPath, type PluginPanel } from '../../shared/plugin';

type PanelPlugin = {
  dir: string;
  panel?: PluginPanel;
};

export function resolvePanelFile(live: PanelPlugin | undefined, relPath: string): string | null {
  if (!live?.panel) return null;
  if (!isSafePanelPath(relPath)) return null;
  const root = path.resolve(live.dir);
  const abs = path.resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  try {
    const real = fs.realpathSync(abs);
    if (real !== root && !real.startsWith(root + path.sep)) return null;
    if (!fs.statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}
