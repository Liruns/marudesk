import { app, BrowserWindow, Menu, session } from 'electron';
// Redirect userData to the active profile BEFORE any persistence module loads.
import './profile-init';
import { persistActiveProfile, profileDir, registerProfileHandlers } from './profile-store';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { maybeOpenEmbeddedDebugPort } from './agent/embedded-browser';
import {
  disposeBrowserView,
  mountBrowserView,
  registerBrowserHandlers,
} from './browser';
import {
  getCurrentWorkspace,
  registerWorkspaceHandlers,
  resetWorkspaceRegistryForProfile,
  restoreWorkspaces,
} from './workspace';
import { setWorkspaceProvider } from './ipc/define-handler';
import { registerWorkspaceMutateHandlers } from './workspace-mutate';
import { registerSshHandlers } from './ssh/handlers';
import { registerGitHandlers } from './git';
import { configureWorktreeIsolation } from './worktree-isolation';
import { activeConversationId, resetThreadsForProfileSwitch } from './agent/loop-state';
import { resetSessionsStoreForProfile } from './agent/sessions-store';
import { configureAutomationStore } from './automations/store';
import { startScheduler, stopScheduler } from './automations/scheduler';
import { createAutomationRunner } from './automations/run';
import { registerAutomationHandlers } from './automations/handlers';
import { registerSearchHandlers } from './search';
import { registerPatchHandlers } from './patch';
import { registerSecretsHandlers } from './secrets';
import { registerOAuthHandlers } from './oauth/handlers';
import { registerCustomProviderHandlers } from './custom-providers';
import { registerAgentHandlers } from './agent/handlers';
import { registerWorkflowHandlers } from './workflows/handlers';
import { registerSpecHandlers } from './specs/handlers';
import { disposeAllLaneDevServers, registerLaneDevHandlers } from './lanes-dev';
import { registerStorageHandlers } from './storage-handlers';
import { registerAppInfoHandlers } from './app-info';
import { registerAutoUpdater } from './updater';
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
import { registerUsageHandlers } from './usage';
import { getSettings, getSettingsSync, registerSettingsHandlers, resetSettingsCacheForProfile } from './settings';
import { destroyTray, syncTrayToSettings } from './tray';
import { flushAndResetHistoryForProfile, registerHistoryHandlers } from './history';
import { registerSuggestHandlers } from './suggest';
import { registerDiagnosticsHandlers } from './diagnostics/handlers';
import { syncFromContext as syncLspFromContext, disposeAllLsp } from './lsp/manager';
import { setContextCacheListener } from './agent/context-cache';
import { registerTerminalHandlers, disposeAllTerminals } from './terminal';
import { registerClipboardHandlers } from './clipboard';
import { registerWindowControlHandlers } from './window-controls';
import { loadWindowState, trackWindowState } from './window-state';
import { closeSplash, showSplash } from './splash';
import { registerUiLayoutHandlers } from './ui-layout';
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
import { startCompanion, stopCompanion } from './server/companion';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
const rendererDevUrl = process.env.VITE_DEV_SERVER_URL;

let mainWindow: BrowserWindow | null = null;
const getMainWindow = (): BrowserWindow | null => mainWindow;

// True once the app is actually exiting (tray Quit, OS shutdown, updater) — the
// close-to-tray handler uses it to tell a real quit from the ✕ button.
let quitting = false;

/** Tray callbacks: restore (or recreate) the main window, and really quit. */
const trayHost = {
  showMainWindow: (): void => {
    const win = mainWindow;
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    } else {
      void createMainWindow();
    }
  },
  quit: (): void => app.quit(),
};

// The automation runner reads the active workspace lazily, so it's profile-
// independent: created once and reused for the IPC handlers and every (re)start
// of the scheduler across live profile switches.
let automationRunner: ReturnType<typeof createAutomationRunner> | null = null;

/**
 * (Re)initialize all per-profile runtime — shared by boot and the live profile
 * switch (applyProfileSwitch). Every step is fire-and-forget and reads the
 * CURRENT userData dir, so it must run AFTER app.setPath has repointed to the
 * target profile.
 */
function initProfileRuntime(): void {
  // Rebuild persisted workspaces from the active profile's disk (no-op until the
  // registry was cleared, which the switch teardown does).
  void restoreWorkspaces();
  // Worktree isolation (Stage 12-B): restore any in-progress isolated worktree
  // and point new ones under the active profile's userData.
  void configureWorktreeIsolation({
    stateFile: path.join(app.getPath('userData'), 'worktree-isolation.json'),
    worktreesDir: path.join(app.getPath('userData'), 'worktrees'),
    getActiveThreadId: activeConversationId,
  });
  // Automations: load the profile's saved schedule and (re)start the tick.
  void configureAutomationStore(path.join(app.getPath('userData'), 'automations.json')).then(() => {
    if (automationRunner) startScheduler(automationRunner);
  });
  // Warm the settings cache, then reconcile the bridge server + cloud relay +
  // tray icon with the new profile's settings.
  void getSettings().then((settings) => {
    void syncServerToSettings(settings);
    void syncRelayToSettings(settings);
    syncTrayToSettings(settings, trayHost);
  });
  // The always-on loopback companion (CLI bridge) — per profile, since the
  // bearer token + cli-bridge.json live in the profile's userData.
  void startCompanion();
  // Connect the profile's external (stdio) MCP servers + activate its plugins.
  void initExternalMcp();
  void initPlugins(() => getCurrentWorkspace()?.root ?? null);
}

/**
 * Tear down the current profile's runtime before a live switch: abort the agent
 * (so nothing keeps writing mid-swap), flush + dispose disk-backed runtime, stop
 * background loops/connections, and clear in-memory caches. All best-effort — a
 * teardown failure must not strand the switch. Runs BEFORE app.setPath, so disk
 * flushes still land in the OLD profile's directory.
 */
async function teardownProfileRuntime(): Promise<void> {
  const guard = (fn: () => void): void => {
    try {
      fn();
    } catch {
      // best-effort — a switch must not be blocked by one failing teardown
    }
  };
  // Abort any in-flight agent turn first, then flush the history debounce to disk.
  guard(resetThreadsForProfileSwitch);
  await flushAndResetHistoryForProfile().catch(() => undefined);
  // Dispose runtime (disposeBrowserView also saves the pinned/tab session to disk).
  guard(disposeBrowserView);
  guard(disposeAllTerminals);
  guard(disposeAllLaneDevServers);
  guard(disposeAllLsp);
  guard(() => void stopServer());
  guard(() => void stopCompanion());
  guard(disposeRelay);
  guard(() => void shutdownExternalMcp());
  guard(shutdownPlugins);
  guard(stopScheduler);
  // Drop in-memory caches so the next read comes from the new profile's dir.
  guard(resetSettingsCacheForProfile);
  guard(resetSessionsStoreForProfile);
  guard(resetWorkspaceRegistryForProfile);
  // Close the SQLite handle LAST so the next getDb() opens the new profile's DB.
  guard(closeDb);
}

/**
 * Apply a profile switch LIVE — no app restart. Persist the new active id, tear
 * down the old profile's runtime, repoint userData, re-init, and reload the
 * renderer (which re-hydrates everything from the new profile). Any failure falls
 * back to the proven hard restart; profiles.json already records the new id, so
 * the relaunched app boots into it cleanly.
 */
async function applyProfileSwitch(id: string): Promise<void> {
  let changed: boolean;
  try {
    changed = await persistActiveProfile(id);
  } catch {
    return; // couldn't even record the choice — leave the running app untouched
  }
  if (!changed) return; // same profile, or an unknown id
  try {
    await teardownProfileRuntime();
    app.setPath('userData', profileDir(id));
    initProfileRuntime();
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.once('did-finish-load', () => {
        if (!win.isDestroyed()) mountBrowserView(win);
      });
      win.webContents.reload();
    }
  } catch {
    app.relaunch();
    app.quit();
  }
}

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
    // `'self'` additionally permits the chat's interactive artifacts, which render
    // as sandboxed `srcdoc` (about:srcdoc) iframes with their own no-network CSP
    // and an opaque origin (v6 §G4/U6).
    "frame-src 'self' plugin:",
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

  // Reveal the window exactly once. `ready-to-show` is preferred (no first-frame
  // flash) but NEVER relied on: on packaged Windows builds the hidden window's
  // first compositor frame can be skipped entirely (timing race with the
  // always-on-top splash shown the same instant the renderer finishes loading),
  // so `ready-to-show` never fires while show() waits for it — the v0.2.0
  // infinite-splash deadlock. Calling show() forces the first frame (observed:
  // `ready-to-show` arrives ~1ms after a forced show), so the deterministic
  // fallbacks below are safe.
  let revealed = false;
  const reveal = (): void => {
    if (revealed) return;
    revealed = true;
    clearTimeout(revealFallback);
    if (!win.isDestroyed()) {
      if (windowState.maximized) win.maximize();
      win.show();
      pushMaximizeState();
      // Boot-storm guard: re-assert visibility once. The reveal can race the
      // splash teardown/focus handoff; if the OS left the window minimized or
      // not actually visible, restore it — a no-op for a healthy window.
      setTimeout(() => {
        if (win.isDestroyed() || (win.isVisible() && !win.isMinimized())) return;
        if (win.isMinimized()) win.restore();
        win.show();
      }, 1_000);
    }
    closeSplash();
  };
  win.once('ready-to-show', reveal);
  // Hard ceiling: even if the renderer never finishes loading, surface the
  // window (and drop the splash) instead of spinning forever.
  const revealFallback = setTimeout(reveal, 10_000);
  // Persist size/position/maximized across restarts.
  trackWindowState(win);

  win.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalUrl(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    const localPrefix = rendererDevUrl ?? 'file://';
    if (!url.startsWith(localPrefix)) {
      event.preventDefault();
      void openExternalUrl(url);
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

  try {
    if (rendererDevUrl) {
      await win.loadURL(rendererDevUrl);
      win.webContents.openDevTools({ mode: 'detach' });
    } else {
      await win.loadFile(path.join(__dirname, '../dist/index.html'));
    }
  } catch (err) {
    // A failed load must still surface a window (blank beats invisible) — the
    // finally below reveals; keep the cause in the log for diagnosis.
    console.error('[main] renderer load failed:', err);
  } finally {
    // Deterministic reveal: the load promise resolving means did-finish-load
    // fired, so the content is ready even if `ready-to-show` never comes.
    reveal();
  }
  pinHostZoom();

  mountBrowserView(win);
  mainWindow = win;
  // Close-to-tray (Settings → Window): unless the app is really quitting, the
  // ✕ button only hides the window and marudesk keeps running — agent turns,
  // terminals, and the bridge server survive. The tray icon (kept in sync with
  // the setting) is the way back in and the real way out.
  win.on('close', (event) => {
    if (quitting) return;
    // E2E/automation runs opt out via env — a hidden-not-closed window would
    // deadlock a harness that expects close() to end the process.
    if (process.env.MARUDESK_DISABLE_TRAY) return;
    if (getSettingsSync().window.closeBehavior !== 'tray') return;
    event.preventDefault();
    win.hide();
  });
  win.on('closed', () => {
    disposeBrowserView();
    mainWindow = null;
  });
  return win;
}

// Open Chromium's remote-debugging endpoint (loopback only) so chrome-devtools-mcp
// can attach to marudesk's embedded browser tabs instead of launching a separate
// local Chrome. Boot-only (the switch has no runtime API) and gated on the
// browser-control preset being enabled — see electron/agent/embedded-browser.ts.
maybeOpenEmbeddedDebugPort();

// Mark the plugin:// scheme privileged (standard + secure) before app-ready so a
// sandboxed panel <iframe> can load it as its own origin (docs/plugin-runtime §8.5).
registerPluginScheme();

void app.whenReady().then(() => {
  // Drop Electron's DEFAULT application menu on Windows/Linux. The window is
  // frameless (no visible menu bar) but the default menu's accelerators stay
  // live — most damagingly its Close Window (Ctrl+W), which closes the whole
  // app whenever no tab handler consumed the key (no tabs open, or focus in a
  // text field), plus Ctrl+R reloading the shell chrome. The app owns all its
  // shortcuts in the renderer + per-view before-input-event handlers. macOS
  // keeps the default menu — the system menu bar carries Cmd+C/V text editing.
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  // Show the splash immediately so there's feedback while handlers register and
  // the renderer loads; closed on the main window's ready-to-show.
  showSplash();
  applyHostContentSecurityPolicy();
  // Serve plugin panel files over plugin:// (path-scoped + strict CSP, see protocol.ts).
  registerPluginProtocol();
  // Wire the current-workspace accessor once; defineHandler's requireWorkspace()
  // reads it for every workspace-scoped channel's "no workspace open" guard.
  setWorkspaceProvider(getCurrentWorkspace);
  registerBrowserHandlers({ getMainWindow });
  registerWorkspaceHandlers({ getMainWindow });
  registerWorkspaceMutateHandlers();
  registerSshHandlers();
  registerGitHandlers();
  // Automations (Stage 12-C): register the IPC handlers with a profile-independent
  // runner; the saved schedule + periodic tick are (re)started in initProfileRuntime.
  automationRunner = createAutomationRunner(getCurrentWorkspace);
  registerAutomationHandlers(automationRunner);
  registerSearchHandlers();
  registerPatchHandlers();
  registerSecretsHandlers();
  registerOAuthHandlers();
  registerModelsHandlers();
  registerCustomProviderHandlers();
  registerUsageHandlers();
  registerAgentHandlers();
  registerWorkflowHandlers();
  registerSpecHandlers();
  registerLaneDevHandlers({ getMainWindow });
  registerStorageHandlers();
  registerAppInfoHandlers();
  // Windows in-app auto-update: registers its IPC handlers always and, on a
  // packaged Windows build, checks for a new release at launch (electron/updater.ts).
  registerAutoUpdater(getMainWindow);
  registerMcpHandlers();
  registerPluginHandlers();
  registerWindowControlHandlers(getMainWindow);
  registerUiLayoutHandlers();
  // Profile switching is applied live (no app restart) — see applyProfileSwitch.
  registerProfileHandlers({ applyProfileSwitch });
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
      // Create/destroy the tray icon as the close-behavior setting flips.
      syncTrayToSettings(settings, trayHost);
    },
  });
  registerHistoryHandlers();
  registerSuggestHandlers();
  registerDiagnosticsHandlers({ getMainWindow });
  // Drive LSP document sync from the editor mirror: when the renderer pushes its
  // open buffers (context:sync), reconcile language servers + open documents for
  // the active workspace root. Inert until a server is configured in languages.json.
  setContextCacheListener((payload) =>
    syncLspFromContext(getCurrentWorkspace()?.root ?? null, payload.editors),
  );
  registerTerminalHandlers({
    getMainWindow,
    getWorkspaceRoot: () => getCurrentWorkspace()?.root ?? null,
  });
  registerClipboardHandlers();
  // Bring up all per-profile runtime: restore workspaces, warm settings (so
  // getSettingsSync() reflects the persisted choice on the first navigation),
  // reconcile the bridge server + cloud relay, start automations, and connect
  // external MCP + plugins. Shared with the live profile switch. Each step is
  // off-by-default / fire-and-forget and never crashes the app.
  initProfileRuntime();
  void createMainWindow().catch((err: unknown) => {
    // If window creation itself dies, never strand the user on the splash.
    console.error('[main] createMainWindow failed:', err);
    closeSplash();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  disposeAllTerminals();
  disposeAllLaneDevServers();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  // Let the close-to-tray handler stand aside — this is a real exit.
  quitting = true;
  destroyTray();
  disposeAllTerminals();
  disposeAllLaneDevServers();
  // Tear down every language server so no spawned LSP process lingers past exit.
  disposeAllLsp();
  // Stop the bridge server so its loopback port is released and no SSE
  // connection lingers past app exit.
  void stopServer();
  // Stop the loopback companion too (removes cli-bridge.json so a CLI doesn't
  // try to reach a dead port).
  void stopCompanion();
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
    void openExternalUrl(url);
    return { action: 'deny' };
  });
});
