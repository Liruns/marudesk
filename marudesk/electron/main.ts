import { app, BrowserWindow, ipcMain, session } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  disposeBrowserView,
  mountBrowserView,
  registerBrowserHandlers,
} from './browser';
import { getCurrentWorkspace, registerWorkspaceHandlers } from './workspace';
import { setWorkspaceProvider } from './ipc/define-handler';
import { registerWorkspaceMutateHandlers } from './workspace-mutate';
import { registerPatchHandlers } from './patch';
import { registerSecretsHandlers } from './secrets';
import { registerOAuthHandlers } from './oauth/handlers';
import { registerCustomProviderHandlers } from './custom-providers';
import { registerAgentHandlers } from './agent/handlers';
import { registerModelsHandlers } from './models';
import { getSettings, registerSettingsHandlers } from './settings';
import { registerHistoryHandlers } from './history';
import { registerTerminalHandlers, disposeAllTerminals } from './terminal';
import { registerClipboardHandlers } from './clipboard';
import { openExternalUrl } from './safe-open';
import { stopServer, syncServerToSettings } from './server';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
const rendererDevUrl = process.env.VITE_DEV_SERVER_URL;

let mainWindow: BrowserWindow | null = null;
const getMainWindow = (): BrowserWindow | null => mainWindow;

function applyHostContentSecurityPolicy(): void {
  const scriptSrc = isDev
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    : "script-src 'self'";

  const cspParts = [
    "default-src 'self'",
    scriptSrc,
    // Monaco runs its language services in web workers; Vite emits them as
    // same-origin chunks (and may use blob: in dev). This loosens worker-src
    // only for our own trusted renderer session — the embedded browsing views
    // run in a separate partition and are unaffected.
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob:",
    "connect-src 'self' https://api.anthropic.com" +
      (isDev ? ' ws://localhost:5173 http://localhost:5173' : ''),
    "object-src 'none'",
    "frame-ancestors 'none'",
  ];

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [cspParts.join('; ') + ';'],
      },
    });
  });
}

async function createMainWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#08090A',
    // Fully frameless on every platform; the renderer paints its own title
    // bar (drag region + min/maximize/close) so the chrome can feel
    // browser-native instead of OS-native.
    frame: false,
    // On macOS we keep the traffic-light buttons but hide the surrounding
    // chrome so the renderer can draw flush to the top edge.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    trafficLightPosition:
      process.platform === 'darwin' ? { x: 14, y: 14 } : undefined,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });

  // Push maximize/unmaximize state so the renderer can swap the icon.
  const pushMaximizeState = (): void => {
    if (win.isDestroyed()) return;
    win.webContents.send('window:maximize-state', win.isMaximized());
  };
  win.on('maximize', pushMaximizeState);
  win.on('unmaximize', pushMaximizeState);
  win.on('enter-full-screen', pushMaximizeState);
  win.on('leave-full-screen', pushMaximizeState);

  win.once('ready-to-show', () => {
    win.show();
    pushMaximizeState();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    const localPrefix = rendererDevUrl ?? 'file://';
    if (!url.startsWith(localPrefix)) {
      event.preventDefault();
      openExternalUrl(url);
    }
  });

  // App-level zoom: intercept Ctrl/Cmd +/-/0 on the HOST renderer so Chromium's
  // built-in zoom (unmanaged, non-persisted, and asymmetric — Ctrl+Shift+- never
  // mapped to zoom-out) can't fire. We forward the intent to the renderer, which
  // zooms the active web page or scales the whole UI via the persisted
  // Interface-zoom setting. A focused web *view* has its own handler
  // (electron/browser/tabs.ts) for when the page itself holds keyboard focus.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.alt) return;
    if (!(input.control || input.meta)) return;
    const k = input.key;
    const dir =
      k === '=' || k === '+'
        ? 'in'
        : k === '-' || k === '_'
          ? 'out'
          : k === '0'
            ? 'reset'
            : null;
    if (!dir) return;
    event.preventDefault();
    win.webContents.send('app:ui-zoom', dir);
  });

  if (rendererDevUrl) {
    await win.loadURL(rendererDevUrl);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    await win.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mountBrowserView(win);
  mainWindow = win;
  win.on('closed', () => {
    disposeBrowserView();
    mainWindow = null;
  });
  return win;
}

function registerWindowControlHandlers(): void {
  ipcMain.handle('window:minimize', () => {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return false;
    win.minimize();
    return true;
  });
  ipcMain.handle('window:maximize-toggle', () => {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return false;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle('window:close', () => {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return false;
    win.close();
    return true;
  });
  ipcMain.handle('window:is-maximized', () => {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return false;
    return win.isMaximized();
  });
}

void app.whenReady().then(() => {
  applyHostContentSecurityPolicy();
  // Wire the current-workspace accessor once; defineHandler's requireWorkspace()
  // reads it for every workspace-scoped channel's "no workspace open" guard.
  setWorkspaceProvider(getCurrentWorkspace);
  registerBrowserHandlers({ getMainWindow });
  registerWorkspaceHandlers({ getMainWindow });
  registerWorkspaceMutateHandlers();
  registerPatchHandlers();
  registerSecretsHandlers();
  registerOAuthHandlers();
  registerModelsHandlers();
  registerCustomProviderHandlers();
  registerAgentHandlers();
  registerWindowControlHandlers();
  registerSettingsHandlers({
    broadcast: (settings) => {
      getMainWindow()?.webContents.send('settings:changed', settings);
      // Reconcile the bridge server with the new settings (start/stop/restart on
      // the server.enabled/port change). Fire-and-forget — a bind failure is
      // handled inside and never crashes the app.
      void syncServerToSettings(settings);
    },
  });
  registerHistoryHandlers();
  registerTerminalHandlers({
    getMainWindow,
    getWorkspaceRoot: () => getCurrentWorkspace()?.root ?? null,
  });
  registerClipboardHandlers();
  // Warm the settings cache so getSettingsSync() (the address-bar/new-tab search
  // engine resolver) reflects the persisted choice on the very first navigation,
  // not just after the renderer's settings:get round-trips. Once loaded, reconcile
  // the bridge server with the persisted server.enabled/port (off by default, so
  // this is a no-op unless the user turned it on previously).
  void getSettings().then((settings) => syncServerToSettings(settings));
  void createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  disposeAllTerminals();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  disposeAllTerminals();
  // Stop the bridge server so its loopback port is released and no SSE
  // connection lingers past app exit.
  void stopServer();
});

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: 'deny' };
  });
});
