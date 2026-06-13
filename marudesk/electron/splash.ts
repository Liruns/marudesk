import { BrowserWindow } from 'electron';

/**
 * A tiny bootstrap splash shown while the main window's renderer loads (the gap
 * between app-ready and `ready-to-show`). It's a standalone pre-React HTML
 * document — it can't use the Tailwind/token classes — so it mirrors the main
 * window's backgroundColor (#08090A) and brand accent inline. Shown immediately,
 * closed once the main window is ready.
 */

const SPLASH_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:#08090A;overflow:hidden}
  .wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#e6e7e9}
  .ring{width:26px;height:26px;border-radius:50%;
    border:2px solid rgba(255,255,255,.14);border-top-color:#6aa3ff;animation:spin .8s linear infinite}
  .title{font-size:19px;font-weight:600;letter-spacing:.01em}
  .sub{font-size:12px;color:#8a8d93}
  @keyframes spin{to{transform:rotate(360deg)}}
</style></head><body><div class="wrap">
  <div class="ring"></div>
  <div class="title">Maru</div>
  <div class="sub">Loading…</div>
</div></body></html>`;

let splash: BrowserWindow | null = null;

/** Show the splash window (no-op if one is already up). Call after app-ready. */
export function showSplash(): void {
  if (splash && !splash.isDestroyed()) return;
  splash = new BrowserWindow({
    width: 360,
    height: 220,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    center: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#08090A',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  void splash.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(SPLASH_HTML));
  splash.once('ready-to-show', () => {
    if (splash && !splash.isDestroyed()) splash.show();
  });
}

/** Close the splash once the main window is ready (idempotent). */
export function closeSplash(): void {
  if (splash && !splash.isDestroyed()) splash.close();
  splash = null;
}
