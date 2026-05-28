import {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  session,
  shell,
} from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  INSPECT_OVERLAY_SCRIPT,
  INSPECT_OVERLAY_TEARDOWN,
} from './inspect-overlay';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
const rendererDevUrl = process.env.VITE_DEV_SERVER_URL;

const INSPECT_PARTITION = 'persist:inspect-target';

type Bounds = { x: number; y: number; width: number; height: number };

let mainWindow: BrowserWindow | null = null;
let browserView: WebContentsView | null = null;

function applyHostContentSecurityPolicy(): void {
  const cspParts = [
    "default-src 'self'",
    "script-src 'self'",
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

function createBrowserView(win: BrowserWindow): WebContentsView {
  const inspectSession = session.fromPartition(INSPECT_PARTITION);
  inspectSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });

  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'inspect-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      partition: INSPECT_PARTITION,
    },
  });

  view.setBackgroundColor('#0F1011');

  view.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  view.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('file://')) {
      event.preventDefault();
    }
  });

  win.contentView.addChildView(view);
  return view;
}

function setBrowserBounds(bounds: Bounds): void {
  if (!browserView) return;
  browserView.setBounds({
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  });
}

async function navigateBrowser(rawUrl: string): Promise<void> {
  if (!browserView) return;
  let url = rawUrl.trim();
  if (!url) return;
  if (url.startsWith('file://')) {
    throw new Error('file:// navigation is not allowed');
  }
  if (!/^https?:\/\//i.test(url) && url !== 'about:blank') {
    url = 'https://' + url;
  }
  await browserView.webContents.loadURL(url);
}

async function setInspectMode(on: boolean): Promise<void> {
  if (!browserView) return;
  const script = on ? INSPECT_OVERLAY_SCRIPT : INSPECT_OVERLAY_TEARDOWN;
  try {
    await browserView.webContents.executeJavaScript(script, true);
  } catch {
    // Page may be navigating; safe to ignore.
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle('browser:navigate', async (_event, url: unknown) => {
    if (typeof url !== 'string') throw new Error('navigate: url must be a string');
    await navigateBrowser(url);
  });

  ipcMain.handle('browser:set-bounds', (_event, bounds: unknown) => {
    if (
      !bounds ||
      typeof bounds !== 'object' ||
      typeof (bounds as Bounds).x !== 'number' ||
      typeof (bounds as Bounds).y !== 'number' ||
      typeof (bounds as Bounds).width !== 'number' ||
      typeof (bounds as Bounds).height !== 'number'
    ) {
      throw new Error('set-bounds: invalid bounds');
    }
    setBrowserBounds(bounds as Bounds);
  });

  ipcMain.handle('browser:set-inspect-mode', async (_event, on: unknown) => {
    if (typeof on !== 'boolean') throw new Error('set-inspect-mode: on must be boolean');
    await setInspectMode(on);
  });

  ipcMain.on('inspect:capture', (event, payload: unknown) => {
    if (!browserView || event.sender.id !== browserView.webContents.id) return;
    mainWindow?.webContents.send('browser:capture', payload);
  });

  ipcMain.on('inspect:exit', async (event) => {
    if (!browserView || event.sender.id !== browserView.webContents.id) return;
    await setInspectMode(false);
    mainWindow?.webContents.send('browser:inspect-exit');
  });
}

async function createMainWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#08090A',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    const localPrefix = rendererDevUrl ?? 'file://';
    if (!url.startsWith(localPrefix)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  if (rendererDevUrl) {
    await win.loadURL(rendererDevUrl);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    await win.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  browserView = createBrowserView(win);
  mainWindow = win;
  return win;
}

void app.whenReady().then(() => {
  applyHostContentSecurityPolicy();
  registerIpcHandlers();
  void createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
});
