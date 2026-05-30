import { WebContentsView } from 'electron';
import { getSettings } from '../settings';
import { getHost, getPaneBounds, type TabRecord } from './state';
import { applyBoundsToActive } from './layout';

/**
 * Custom browser DevTools. Rather than build a DevTools UI from scratch, we
 * host Chromium's real DevTools: in 'side' mode it renders into a WebContentsView
 * we own and position (so we control the dock); in 'popup' mode it detaches into
 * its own window. The app-level Electron DevTools (main.ts, dev only) is separate
 * and stays for debugging marudesk itself. Closing DevTools never destroys the
 * docked view — closeDevtools does.
 */

export async function openDevtools(rec: TabRecord): Promise<void> {
  // DevTools docking isn't supported while the tab grid is active — the side
  // dock would fight the pane layout. No-op until the grid is dismissed.
  if (getPaneBounds()) return;
  if (!rec.view || rec.devtoolsMode || rec.devtoolsOpening) return;
  rec.devtoolsOpening = true;
  try {
    const { defaultDock } = (await getSettings()).devtools;
    if (!rec.view || rec.devtoolsMode) return;
    if (defaultDock === 'popup') {
      rec.devtoolsMode = 'popup';
      rec.view.webContents.openDevTools({ mode: 'detach' });
      return;
    }
    const host = getHost();
    if (!host || host.isDestroyed()) return;
    const dt = new WebContentsView();
    rec.devtoolsView = dt;
    rec.devtoolsMode = 'side';
    host.contentView.addChildView(dt);
    rec.view.webContents.setDevToolsWebContents(dt.webContents);
    rec.view.webContents.openDevTools();
    applyBoundsToActive();
  } finally {
    rec.devtoolsOpening = false;
  }
}

export function closeDevtools(rec: TabRecord): void {
  if (!rec.devtoolsMode) return;
  try {
    rec.view?.webContents.closeDevTools();
  } catch {
    // ignore
  }
  if (rec.devtoolsView) {
    try {
      getHost()?.contentView.removeChildView(rec.devtoolsView);
    } catch {
      // ignore
    }
    try {
      rec.devtoolsView.webContents.close();
    } catch {
      // ignore
    }
    rec.devtoolsView = null;
  }
  rec.devtoolsMode = null;
  applyBoundsToActive();
}

export function toggleDevtools(rec: TabRecord): void {
  if (rec.devtoolsMode) closeDevtools(rec);
  else void openDevtools(rec);
}

export async function inspectElementAt(
  rec: TabRecord,
  x: number,
  y: number,
): Promise<void> {
  if (!rec.view) return;
  const wc = rec.view.webContents;
  if (rec.devtoolsMode) {
    wc.inspectElement(x, y);
    return;
  }
  // Wait for the DevTools front-end to actually connect before inspecting,
  // otherwise the Elements panel can open blank on first launch
  // (electron#27110 / #17168).
  const opened = new Promise<void>((resolve) =>
    wc.once('devtools-opened', () => resolve()),
  );
  await openDevtools(rec);
  if (!rec.devtoolsMode) return;
  await opened;
  wc.inspectElement(x, y);
}
