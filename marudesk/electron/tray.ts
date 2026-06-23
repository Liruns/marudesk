import { app, Menu, nativeImage, Tray } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppSettings } from '../shared/settings';
import type { TrayLabels } from '../shared/app-info';

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
// The host last used to build the menu, kept so setTrayLabels can rebuild the
// menu in place when localized labels arrive after the tray already exists.
let trayHost: TrayHost | null = null;

/** English defaults until the renderer pushes localized labels (see setTrayLabels). */
const DEFAULT_TRAY_LABELS: TrayLabels = { open: 'Open Maru', quit: 'Quit Maru' };
let trayLabels: TrayLabels = DEFAULT_TRAY_LABELS;

function buildTrayMenu(host: TrayHost): Menu {
  return Menu.buildFromTemplate([
    { label: trayLabels.open, click: () => host.showMainWindow() },
    { type: 'separator' },
    { label: trayLabels.quit, click: () => host.quit() },
  ]);
}

/**
 * Replace the tray labels with the renderer's localized set and rebuild the menu
 * if the tray is currently shown. The payload is untrusted, so each field is
 * coerced to a non-empty string and falls back to the English default.
 */
export function setTrayLabels(raw: unknown): void {
  const src = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const pick = (key: keyof TrayLabels): string =>
    typeof src[key] === 'string' && src[key] !== '' ? (src[key] as string) : DEFAULT_TRAY_LABELS[key];
  trayLabels = { open: pick('open'), quit: pick('quit') };
  if (tray && trayHost) tray.setContextMenu(buildTrayMenu(trayHost));
}

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
  trayHost = host;
  tray = new Tray(trayIcon());
  tray.setToolTip('Maru');
  tray.setContextMenu(buildTrayMenu(host));
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
