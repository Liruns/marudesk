import { app } from 'electron';
import path from 'node:path';

/**
 * Electron-side resolver for the pinned-host-key store (see ./host-keys.ts,
 * which stays electron-free so the headless harness can run it under plain
 * Node). Lives next to settings.json in the active profile's userData dir.
 */
export function knownHostsFile(): string {
  return path.join(app.getPath('userData'), 'ssh-known-hosts.json');
}
