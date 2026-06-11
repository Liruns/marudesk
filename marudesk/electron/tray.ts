import { app, Menu, nativeImage, Tray } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppSettings } from '../shared/settings';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Close-to-tray (Settings → Window). When `window.closeBehavior` is 'tray',
 * closing the window only hides it and the app keeps running here: the tray
 * icon is the way back in (click → restore) and the real way out (Quit). The
 * icon exists exactly while the behavior is active — `syncTrayToSettings`
 * creates/destroys it at boot and on every settings change, so 'quit' users
 * never see a stray tray icon. Window/quit actions route through {@link TrayHost}
 * so this module owns no window state of its own.
 */

export type TrayHost = {
  /** Restore (or recreate) the main window and focus it. */
  showMainWindow: () => void;
  /** Really exit — sets the quitting flag via before-quit, then closes. */
  quit: () => void;
};

let tray: Tray | null = null;

function trayIcon(): Electron.NativeImage {
  // Packaged: build/icon.png shipped via electron-builder extraResources →
  // resources/icon.png. Dev: the repo file, relative to dist-electron/.
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'icon.png')]
    : [path.join(__dirname, '../build/icon.png')];
  for (const candidate of candidates) {
    const img = nativeImage.createFromPath(candidate);
    // Tray icons render at 16px logical — downscale once here instead of
    // handing the OS the full-size app icon.
    if (!img.isEmpty()) return img.resize({ width: 16, height: 16 });
  }
  return nativeImage.createEmpty();
}

export function ensureTray(host: TrayHost): void {
  if (tray) return;
  tray = new Tray(trayIcon());
  tray.setToolTip('marudesk');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open marudesk', click: () => host.showMainWindow() },
      { type: 'separator' },
      { label: 'Quit marudesk', click: () => host.quit() },
    ]),
  );
  // Single left-click restores the window (Windows convention; macOS opens the
  // context menu via the OS regardless).
  tray.on('click', () => host.showMainWindow());
}

export function destroyTray(): void {
  tray?.destroy();
  tray = null;
}

/** Reconcile the tray icon with settings — called at boot and on every change. */
export function syncTrayToSettings(settings: AppSettings, host: TrayHost): void {
  // E2E/automation runs opt out entirely (no stray OS tray icons during tests);
  // the matching close-handler guard lives in electron/main.ts.
  if (process.env.MARUDESK_DISABLE_TRAY) return destroyTray();
  if (settings.window.closeBehavior === 'tray') ensureTray(host);
  else destroyTray();
}
