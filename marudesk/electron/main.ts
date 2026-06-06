import { app, BrowserWindow, session } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  disposeBrowserView,
  mountBrowserView,
  registerBrowserHandlers,
} from './browser';
import { getCurrentWorkspace, registerWorkspaceHandlers, restoreWorkspaces } from './workspace';
import { setWorkspaceProvider } from './ipc/define-handler';
import { registerWorkspaceMutateHandlers } from './workspace-mutate';
import { registerSshHandlers } from './ssh/handlers';
import { registerGitHandlers } from './git';
import { registerSearchHandlers } from './search';
import { registerPatchHandlers } from './patch';
import { registerSecretsHandlers } from './secrets';
import { registerOAuthHandlers } from './oauth/handlers';
import { registerCustomProviderHandlers } from './custom-providers';
import { registerAgentHandlers } from './agent/handlers';
import { registerStorageHandlers } from './storage-handlers';
import { registerAppInfoHandlers } from './app-info';
import { closeDb } from './db';
import {
  initExternalMcp,
  registerMcpHandlers,
  shutdownExternalMcp,
} from './agent/mcp-handlers';
import { initPlugins, shutdownPlugins } from './plugins';
import { registerPluginHandlers } from './plugins/handlers';
import { registerPluginProtocol, registerPluginScheme } from './plugins/protocol';
import { registerModelsHandlers } from './models';
import { getSettings, registerSettingsHandlers } from './settings';
import { registerHistoryHandlers } from './history';
import { registerTerminalHandlers, disposeAllTerminals } from './terminal';
import { registerClipboardHandlers } from './clipboard';
import { registerWindowControlHandlers } from './window-controls';
import { loadWindowState, trackWindowState } from './window-state';
import { openExternalUrl } from './safe-open';
import {
  registerServerHandlers,
  setPairingRequestListener,
  setServerStatusListener,
  stopServer,
  syncServerToSettings,
} from './server';
import {
  disposeRelay,
  registerRelayHandlers,
  setRelayStatusListener,
  syncRelayToSettings,
} from './server/relay';

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
    // Generated videos (generate_video) are inlined into the chat as data: URLs
    // (see GeneratedMedia); without an explicit media-src they fall back to
    // default-src 'self' and the <video> source is blocked.
    "media-src 'self' data: blob:",
    "connect-src 'self' https://api.anthropic.com" +
      (isDev ? ' ws://localhost:5173 http://localhost:5173' : ''),
    "object-src 'none'",
    "frame-ancestors 'none'",
    // Plugin UI panels load in a sandboxed <iframe> from the privileged plugin://
    // scheme (docs/plugin-runtime-design §8.5); allow embedding it (the iframe's
    // OWN document gets a strict, no-network CSP from the protocol handler).
    'frame-src plugin:',
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
  const windowState = loadWindowState();
  const win = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    ...(windowState.x !== undefined && windowState.y !== undefined
      ? { x: windowState.x, y: windowState.y }
      : {}),
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
    if (windowState.maximized) win.maximize();
    win.show();
    pushMaximizeState();
  });
  // Persist size/position/maximized across restarts.
  trackWindowState(win);

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

  // The HOST renderer's zoom is owned entirely by the app's "Interface zoom"
  // setting (a CSS root-font-size scale), never Chromium's built-in page zoom.
  // Chromium persists a per-origin zoom level in the session, so a stray Ctrl+'+'
  // pressed before the app-zoom interception above existed would otherwise stick
  // FOREVER: it scales the whole chrome (oversized icons, menu, terminal) AND —
  // because a zoomed renderer reports zoomed CSS-px rects that we hand to
  // WebContentsView.setBounds() as DIP — shoves the embedded browser view toward
  // the top-left at the wrong size. Pin the host to zoom 0 on every load and lock
  // pinch-zoom so the Interface-zoom setting is the only zoom knob. Setting the
  // level also rewrites the persisted value, so this self-heals a profile that
  // already carries a stuck zoom.
  const pinHostZoom = (): void => {
    if (win.isDestroyed()) return;
    win.webContents.setVisualZoomLevelLimits(1, 1);
    win.webContents.setZoomLevel(0);
  };
  win.webContents.on('did-finish-load', pinHostZoom);

  if (rendererDevUrl) {
    await win.loadURL(rendererDevUrl);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    await win.loadFile(path.join(__dirname, '../dist/index.html'));
  }
  pinHostZoom();

  mountBrowserView(win);
  mainWindow = win;
  win.on('closed', () => {
    disposeBrowserView();
    mainWindow = null;
  });
  return win;
}

// Mark the plugin:// scheme privileged (standard + secure) before app-ready so a
// sandboxed panel <iframe> can load it as its own origin (docs/plugin-runtime §8.5).
registerPluginScheme();

void app.whenReady().then(() => {
  applyHostContentSecurityPolicy();
  // Serve plugin panel files over plugin:// (path-scoped + strict CSP, see protocol.ts).
  registerPluginProtocol();
  // Wire the current-workspace accessor once; defineHandler's requireWorkspace()
  // reads it for every workspace-scoped channel's "no workspace open" guard.
  setWorkspaceProvider(getCurrentWorkspace);
  registerBrowserHandlers({ getMainWindow });
  registerWorkspaceHandlers({ getMainWindow });
  // Rebuild persisted workspaces from disk (fire-and-forget — re-indexes local
  // roots, then pushes state once the renderer is listening).
  void restoreWorkspaces();
  registerWorkspaceMutateHandlers();
  registerSshHandlers();
  registerGitHandlers();
  registerSearchHandlers();
  registerPatchHandlers();
  registerSecretsHandlers();
  registerOAuthHandlers();
  registerModelsHandlers();
  registerCustomProviderHandlers();
  registerAgentHandlers();
  registerStorageHandlers();
  registerAppInfoHandlers();
  registerMcpHandlers();
  registerPluginHandlers();
  registerWindowControlHandlers(getMainWindow);
  registerRelayHandlers();
  // Push live cloud-relay status (connected-as-host / session changes) to the
  // renderer so Settings reflects it without polling. Sanitized — never tokens.
  setRelayStatusListener((status) =>
    getMainWindow()?.webContents.send('relay:status-changed', status),
  );
  registerServerHandlers();
  // Push live bridge-server status (start/stop → running flag + reachable
  // LAN/Tailscale URLs) so the Settings Remote panel updates without polling.
  setServerStatusListener((status) =>
    getMainWindow()?.webContents.send('server:status-changed', status),
  );
  // Push a pairing request to the renderer so Settings can show the approve/reject
  // card when a phone scans the QR (T2 ③ — docs/t2-secure-pairing-design.md).
  setPairingRequestListener((info) =>
    getMainWindow()?.webContents.send('server:pairing-request', info),
  );
  registerSettingsHandlers({
    broadcast: (settings) => {
      getMainWindow()?.webContents.send('settings:changed', settings);
      // Reconcile the bridge server with the new settings (start/stop/restart on
      // the server.enabled/port change). Fire-and-forget — a bind failure is
      // handled inside and never crashes the app.
      void syncServerToSettings(settings);
      // Reconcile the cloud-relay host (connect/disconnect on the cloudEnabled /
      // relayUrl change). Also fire-and-forget — connection errors are swallowed
      // by the relay-client's reconnect and never crash the app.
      void syncRelayToSettings(settings);
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
  void getSettings().then((settings) => {
    void syncServerToSettings(settings);
    // Connect the cloud-relay host if cloud is enabled AND a session is stored
    // (off by default → a no-op unless the user logged in + enabled it before).
    void syncRelayToSettings(settings);
  });
  // Connect any user-configured external (stdio) MCP servers (off by default — the
  // config file ships empty, so this is a no-op until the user adds one). A
  // per-server spawn/init failure is handled inside the manager and never crashes
  // the app — see docs/remote-mobile-bridge-design §M3.
  void initExternalMcp();
  // Scan the user/project plugin folders and activate any the user has approved
  // (docs/plugin-runtime-design.md). Off by default — nothing is spawned until a
  // plugin is enabled + its permissions granted in Settings, and a bad manifest /
  // failed load is recorded and skipped, never crashing the app.
  void initPlugins(() => getCurrentWorkspace()?.root ?? null);
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
  // Stop reconnecting + close the outbound cloud-relay host WS on quit.
  disposeRelay();
  // Close every external MCP stdio connection so no spawned child process lingers
  // past app exit.
  void shutdownExternalMcp();
  // Tear down every plugin worker so no utilityProcess lingers past app exit.
  shutdownPlugins();
  // Close the SQLite handle (flushes the WAL) if it was opened.
  closeDb();
});

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: 'deny' };
  });
});
