import { getActiveTabId, getHost, pushState, type TabRecord } from './state';
import { zoomActive } from './zoom';

/**
 * Keyboard-shortcut dispatch for a web tab's `before-input-event`. The host
 * renderer's window keydown can't see these (focus is in the embedded
 * webContents), so the main process intercepts them here — the mirror of
 * Shell.tsx's handler for when the React chrome has focus. The two are mutually
 * exclusive by focus, so a shortcut never double-fires. Extracted from
 * createTab; only the active/visible tab acts.
 */
export function handleTabShortcut(
  rec: TabRecord,
  event: Electron.Event,
  input: Electron.Input,
): void {
    if (input.type !== 'keyDown') return;
    // Only the active/visible tab — a background contents must not drive the
    // dock or navigation, which always track the active tab.
    if (rec.id !== getActiveTabId()) return;
    const mod = input.control || input.meta;
    const key = input.key.toLowerCase();
    const wc = rec.view?.webContents;

    // DevTools: F12 / Ctrl+Shift+I → forward to the renderer (it owns the grid
    // guard, the dock-vs-chrome choice, and the CDP attach).
    if (input.key === 'F12' || (mod && input.shift && key === 'i')) {
      event.preventDefault();
      const h = getHost();
      if (h && !h.isDestroyed()) {
        h.webContents.send('devtools:toggle', { tabId: rec.id });
      }
      return;
    }
    // Tab navigation (Ctrl+Tab / Ctrl+Shift+Tab cycle, Ctrl/Cmd+1–9 jump). The
    // renderer owns the tab list + activation, so forward the intent to the host
    // — the mirror of Shell.tsx's window keydown for the chrome-focused case.
    // Placed before the `wc` guard since these don't act on the page.
    if (input.control && input.key === 'Tab') {
      event.preventDefault();
      const h = getHost();
      if (h && !h.isDestroyed()) {
        h.webContents.send('app:tab-shortcut', {
          type: 'cycle',
          dir: input.shift ? -1 : 1,
        });
      }
      return;
    }
    if (mod && !input.shift && !input.alt && /^[1-9]$/.test(input.key)) {
      event.preventDefault();
      const h = getHost();
      if (h && !h.isDestroyed()) {
        h.webContents.send('app:tab-shortcut', {
          type: 'jump',
          digit: Number(input.key),
        });
      }
      return;
    }
    // Split-pane shortcuts: Ctrl+Alt+Arrow cycles pane focus, Ctrl+Shift+Enter
    // zooms the focused pane. No-ops in the renderer when there's no split.
    if (input.control && input.alt && (input.key === 'ArrowLeft' || input.key === 'ArrowRight' || input.key === 'ArrowUp' || input.key === 'ArrowDown')) {
      event.preventDefault();
      const h = getHost();
      const dir = input.key === 'ArrowLeft' || input.key === 'ArrowUp' ? -1 : 1;
      if (h && !h.isDestroyed()) {
        h.webContents.send('app:tab-shortcut', { type: 'pane-cycle', dir });
      }
      return;
    }
    if (input.control && input.shift && input.key === 'Enter') {
      event.preventDefault();
      const h = getHost();
      if (h && !h.isDestroyed()) {
        h.webContents.send('app:tab-shortcut', { type: 'pane-maximize' });
      }
      return;
    }
    if (!wc) return;

    // Reload: F5 / Ctrl+R (normal), Ctrl+Shift+R (hard, ignore cache).
    if (input.key === 'F5' || (mod && key === 'r')) {
      event.preventDefault();
      if (mod && input.shift && key === 'r') wc.reloadIgnoringCache();
      else wc.reload();
      return;
    }
    // History: Alt+Left / Alt+Right.
    if (input.alt && (input.key === 'ArrowLeft' || input.key === 'ArrowRight')) {
      event.preventDefault();
      const nh = wc.navigationHistory;
      if (input.key === 'ArrowLeft') {
        if (nh.canGoBack()) nh.goBack();
      } else if (nh.canGoForward()) {
        nh.goForward();
      }
      return;
    }
    // Focus the address bar: Ctrl/Cmd+L. Pull keyboard focus to the host
    // renderer first (it's in the embedded view right now), then ask it to focus
    // + select the address input.
    if (mod && key === 'l') {
      event.preventDefault();
      const h = getHost();
      if (h && !h.isDestroyed()) {
        h.webContents.focus();
        h.webContents.send('browser:focus-address-bar');
      }
      return;
    }
    // Find in page: Ctrl/Cmd+F → pull focus to the host and open the find bar.
    if (mod && key === 'f') {
      event.preventDefault();
      const h = getHost();
      if (h && !h.isDestroyed()) {
        h.webContents.focus();
        h.webContents.send('browser:open-find');
      }
      return;
    }
    // Page zoom: Ctrl/Cmd with '=' / '+' (in), '-' (out), '0' (reset). pushState
    // carries the new factor to the toolbar indicator.
    if (mod && (input.key === '=' || input.key === '+')) {
      event.preventDefault();
      zoomActive('in');
      pushState();
      return;
    }
    if (mod && (input.key === '-' || input.key === '_')) {
      event.preventDefault();
      zoomActive('out');
      pushState();
      return;
    }
    if (mod && input.key === '0') {
      event.preventDefault();
      zoomActive('reset');
      pushState();
      return;
    }
}
