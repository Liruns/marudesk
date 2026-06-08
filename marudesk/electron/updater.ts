import { createRequire } from 'node:module';
import { app, type BrowserWindow } from 'electron';
import type { AppUpdater, ProgressInfo, UpdateInfo } from 'electron-updater';
import type { UpdateStatus } from '../shared/app-info';
import { defineHandler } from './ipc/define-handler';
import { toMessage } from '../shared/to-message';

/**
 * Windows in-app auto-update (decision: electron-updater, Windows only, check on
 * launch). This is distinct from the manual GitHub-API check in app-info.ts,
 * which only opens the browser to the releases page. Here the new NSIS package is
 * downloaded in the background and installed on the user's "restart" click (or on
 * the next quit). It reads its feed from `app-update.yml`, which electron-builder
 * generates into the packaged resources from the `build.publish` (GitHub) config.
 *
 * electron-updater is an external CommonJS dependency (see vite.config.ts). Load
 * it through createRequire so the ESM `main.mjs` bundle resolves it at runtime
 * without relying on Node's CJS named-export detection. `module.exports.autoUpdater`
 * is a lazy getter that instantiates the platform updater (and reads `app`), so we
 * keep the module reference here and only touch `.autoUpdater` from inside
 * registerAutoUpdater(), which runs after app-ready.
 */
const require = createRequire(import.meta.url);
const updaterModule = require('electron-updater') as {
  readonly autoUpdater: AppUpdater;
};

let currentStatus: UpdateStatus = { kind: 'disabled' };
let getWindow: () => BrowserWindow | null = () => null;
// `download-progress` carries no version, so remember the target from the
// available/downloaded events to keep the renderer's progress label populated.
let targetVersion = '';

function setStatus(next: UpdateStatus): void {
  currentStatus = next;
  getWindow()?.webContents.send('app:update-status-changed', next);
}

function wireEvents(autoUpdater: AppUpdater): void {
  autoUpdater.on('checking-for-update', () => setStatus({ kind: 'checking' }));
  autoUpdater.on('update-available', (info: UpdateInfo) => {
    targetVersion = info.version;
    // autoDownload is on, so the download starts immediately after this.
    setStatus({ kind: 'available', version: info.version });
  });
  autoUpdater.on('update-not-available', () =>
    setStatus({ kind: 'not-available' }),
  );
  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    setStatus({
      kind: 'downloading',
      version: targetVersion,
      percent: Math.round(progress.percent),
    });
  });
  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    targetVersion = info.version;
    setStatus({ kind: 'downloaded', version: info.version });
  });
  autoUpdater.on('error', (err: Error) =>
    setStatus({ kind: 'error', message: toMessage(err) }),
  );
}

/**
 * Register the auto-updater IPC handlers and, on a packaged Windows build, kick
 * off the launch-time check. The handlers are always registered so the renderer's
 * `app:update-status` / `app:quit-and-install` invokes never reject; on dev or a
 * non-Windows platform the status stays `disabled` and quit-and-install is inert.
 */
export function registerAutoUpdater(
  getMainWindow: () => BrowserWindow | null,
): void {
  getWindow = getMainWindow;

  // Touching `.autoUpdater` instantiates the platform updater (NSIS on Windows);
  // safe here because registerAutoUpdater runs after app-ready.
  const { autoUpdater } = updaterModule;

  defineHandler('app:update-status', () => currentStatus);
  defineHandler('app:quit-and-install', () => {
    if (currentStatus.kind !== 'downloaded') return;
    // The user explicitly asked to restart now: isSilent=false (show the NSIS
    // progress), forceRunAfter=true (relaunch the app once installed).
    autoUpdater.quitAndInstall(false, true);
  });

  if (!app.isPackaged || process.platform !== 'win32') {
    // Auto-update runs only for packaged Windows; leave status `disabled`.
    return;
  }

  currentStatus = { kind: 'idle' };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  wireEvents(autoUpdater);

  // Fire-and-forget: a missing feed / network failure surfaces via the `error`
  // event (and the catch below) and never blocks or crashes startup.
  autoUpdater.checkForUpdates().catch((err: unknown) => {
    setStatus({ kind: 'error', message: toMessage(err) });
  });
}
