import { ipcMain, type BrowserWindow } from 'electron';

type MainWindowProvider = () => BrowserWindow | null;

export function registerWindowControlHandlers(
  getMainWindow: MainWindowProvider,
): void {
  ipcMain.handle('window:minimize', () => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return false;
    win.minimize();
    return true;
  });
  ipcMain.handle('window:maximize-toggle', () => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return false;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle('window:close', () => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return false;
    win.close();
    return true;
  });
  ipcMain.handle('window:is-maximized', () => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return false;
    return win.isMaximized();
  });
}
