import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import type { AppSettings } from '../../../shared/settings';
import { fontStack } from '../../../shared/fonts';
import { resolveTheme, subscribeAppearance, useSettingsStore } from '../settings/store';
import { subscribeTabsByKind } from '../tabs/store';
import { toMessage } from '../../lib/toMessage';

/** Event a session fires (bubbling) to ask its surface to open the search bar. */
export const TERMINAL_OPEN_SEARCH_EVENT = 'terminal:open-search';

const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.userAgent);

/**
 * Terminal sessions outlive the React component that shows them. Each session
 * owns a detached container that xterm renders into; TerminalView re-parents
 * that container into its host on mount and detaches it on unmount. So
 * switching tabs (or away to a web tab and back) keeps the live shell, its
 * scrollback, and any running process — the PTY is disposed only when the
 * terminal tab actually closes (the prune subscription below, mirroring the
 * editor's model pruning). Keyed by the terminal tab's id.
 */

function xtermTheme(resolved: 'dark' | 'light') {
  return resolved === 'light'
    ? {
        background: '#FFFFFF',
        foreground: '#1C1D21',
        cursor: '#5E6AD2',
        cursorAccent: '#FFFFFF',
        selectionBackground: 'rgba(94, 106, 210, 0.25)',
      }
    : {
        background: '#08090A',
        foreground: '#F7F8F8',
        cursor: '#5E6AD2',
        cursorAccent: '#08090A',
        selectionBackground: 'rgba(94, 106, 210, 0.32)',
      };
}

type Session = {
  container: HTMLDivElement;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  ptyId: string | null;
  cleanup: () => void;
};

const sessions = new Map<string, Session>();

/** Copy the current selection to the OS clipboard (via main), then clear it. */
function copyFromTerm(session: Session): void {
  const sel = session.term.getSelection();
  if (!sel) return;
  void window.marudesk.invoke('clipboard:write-text', sel);
  // Clearing the selection means a subsequent Ctrl+C falls through as SIGINT
  // rather than re-copying — matching Windows Terminal / VSCode behavior.
  session.term.clearSelection();
}

/**
 * Paste OS clipboard text into the PTY. term.paste() brackets the text
 * (\x1b[200~…\x1b[201~) when the shell has enabled bracketed-paste mode — which
 * bash 4.4+/zsh/pwsh/fish do, so a multi-line paste there won't auto-execute;
 * shells that don't opt in (cmd.exe, bare sh) receive it raw, as in any terminal.
 */
async function pasteIntoTerm(session: Session): Promise<void> {
  try {
    const text = await window.marudesk.invoke('clipboard:read-text');
    if (text) session.term.paste(text);
  } catch {
    // Surface the failure instead of a dead Ctrl+V: a dim inline note (display
    // only — not sent to the PTY) so the user knows the paste didn't land
    // because the clipboard was locked or unreadable.
    session.term.write('\r\n\x1b[2m[clipboard unavailable]\x1b[0m\r\n');
  }
}

/**
 * Terminal copy/paste/select-all/find keybindings, layered over xterm via
 * attachCustomKeyEventHandler. Returning false tells xterm to skip its own
 * handling; we also stop the event so app-level shortcuts don't double-fire.
 * Conventions follow VSCode / Windows Terminal:
 *   - Cmd+C / Cmd+V / Cmd+A / Cmd+F on macOS.
 *   - Ctrl+Shift+C / Ctrl+Shift+V / Ctrl+Shift+A and Ctrl+F on Windows/Linux,
 *     plus Ctrl+C copying *only when there's a selection* (else it stays SIGINT)
 *     and Ctrl+V pasting.
 */
function handleTerminalKey(session: Session, e: KeyboardEvent): boolean {
  if (e.type !== 'keydown') return true;
  const primary = IS_MAC ? e.metaKey : e.ctrlKey;
  if (!primary) return true;
  const term = session.term;
  const stop = (): false => {
    e.preventDefault();
    e.stopPropagation();
    return false;
  };

  if (e.code === 'KeyC') {
    if (IS_MAC) {
      copyFromTerm(session);
      return stop();
    }
    if (e.shiftKey || term.hasSelection()) {
      copyFromTerm(session);
      return stop();
    }
    return true; // bare Ctrl+C, no selection → let the shell receive SIGINT
  }

  if (e.code === 'KeyV') {
    void pasteIntoTerm(session);
    return stop();
  }

  if (e.code === 'KeyA' && (IS_MAC || e.shiftKey)) {
    term.selectAll();
    return stop();
  }

  if (e.code === 'KeyF' && !e.shiftKey) {
    session.container.dispatchEvent(
      new CustomEvent(TERMINAL_OPEN_SEARCH_EVENT, { bubbles: true }),
    );
    return stop();
  }

  return true;
}

function applyTermSettings(session: Session, s: AppSettings): void {
  const { term, fit } = session;
  term.options.fontFamily = fontStack(s.appearance.terminalFontFamily, 'mono');
  term.options.fontSize = s.appearance.terminalFontSize;
  term.options.theme = xtermTheme(resolveTheme(s.appearance.theme));
  try {
    fit.fit();
  } catch {
    // Container not attached yet; fit happens on attach.
  }
  if (session.ptyId) {
    void window.marudesk.invoke('terminal:resize', {
      id: session.ptyId,
      cols: term.cols,
      rows: term.rows,
    });
  }
}

/** Get the session for a terminal tab, creating its xterm + PTY on first use. */
export function acquireTerminalSession(tabId: string): Session {
  const existing = sessions.get(tabId);
  if (existing) return existing;

  const container = document.createElement('div');
  container.style.width = '100%';
  container.style.height = '100%';

  const settings = useSettingsStore.getState().settings;
  const term = new Terminal({
    fontFamily: fontStack(settings.appearance.terminalFontFamily, 'mono'),
    fontSize: settings.appearance.terminalFontSize,
    cursorBlink: true,
    scrollback: 5000,
    // We provide our own right-click context menu, so stop xterm from selecting
    // a word on right-click (which would clobber the selection Copy acts on).
    rightClickSelectsWord: false,
    theme: xtermTheme(resolveTheme(settings.appearance.theme)),
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(
    new WebLinksAddon((_event, uri) => {
      // Open in the user's default browser through main's window-open handler
      // (setWindowOpenHandler → openExternalUrl). Restrict to http(s) so a
      // crafted file:// link in shell output isn't one-click launchable.
      if (/^https?:\/\//i.test(uri)) {
        window.open(uri, '_blank', 'noopener,noreferrer');
      }
    }),
  );
  term.open(container);

  const session: Session = {
    container,
    term,
    fit,
    search,
    ptyId: null,
    cleanup: () => {},
  };
  sessions.set(tabId, session);
  term.attachCustomKeyEventHandler((e) => handleTerminalKey(session, e));

  let offData: (() => void) | null = null;
  let offExit: (() => void) | null = null;

  window.marudesk
    .invoke('terminal:create', {
      cols: term.cols || 80,
      rows: term.rows || 24,
    })
    .then((res) => {
      if (sessions.get(tabId) !== session) {
        // Tab closed before the PTY came up — don't leak it.
        void window.marudesk.invoke('terminal:dispose', res.id);
        return;
      }
      session.ptyId = res.id;
      offData = window.marudesk.on('terminal:data', (p) => {
        if (p.id === res.id) term.write(p.data);
      });
      offExit = window.marudesk.on('terminal:exit', (p) => {
        if (p.id !== res.id) return;
        const code = typeof p.exitCode === 'number' ? ` (${p.exitCode})` : '';
        term.write(`\r\n\x1b[2m[process exited${code}]\x1b[0m\r\n`);
      });
      // Listeners are wired — let main flush any output buffered pre-subscribe.
      void window.marudesk.invoke('terminal:ready', { id: res.id });
    })
    .catch((err: unknown) => {
      const msg = toMessage(err);
      term.write(`\r\n\x1b[31m[failed to start terminal: ${msg}]\x1b[0m\r\n`);
    });

  const onData = term.onData((data) => {
    if (session.ptyId) {
      void window.marudesk.invoke('terminal:input', { id: session.ptyId, data });
    }
  });

  const unsubAppearance = subscribeAppearance((s) =>
    applyTermSettings(session, s),
  );

  session.cleanup = () => {
    unsubAppearance();
    onData.dispose();
    offData?.();
    offExit?.();
    if (session.ptyId) void window.marudesk.invoke('terminal:dispose', session.ptyId);
    term.dispose();
  };

  return session;
}

/** Re-fit a session to its host and tell the PTY the new dimensions. */
export function fitTerminalSession(tabId: string): void {
  const session = sessions.get(tabId);
  if (!session) return;
  try {
    session.fit.fit();
  } catch {
    return;
  }
  if (session.ptyId) {
    void window.marudesk.invoke('terminal:resize', {
      id: session.ptyId,
      cols: session.term.cols,
      rows: session.term.rows,
    });
  }
}

/* ── Imperative actions, used by the surface (context menu + search bar) ──── */

/** True when the terminal currently has a non-empty selection. */
export function terminalHasSelection(tabId: string): boolean {
  return sessions.get(tabId)?.term.hasSelection() ?? false;
}

/** Copy the current selection to the clipboard (no-op without one). */
export function terminalCopySelection(tabId: string): void {
  const session = sessions.get(tabId);
  if (session) copyFromTerm(session);
}

/** Paste clipboard text into the PTY. */
export function terminalPaste(tabId: string): void {
  const session = sessions.get(tabId);
  if (session) void pasteIntoTerm(session);
}

/** Select the entire scrollback + viewport. */
export function terminalSelectAll(tabId: string): void {
  sessions.get(tabId)?.term.selectAll();
}

/** Clear the scrollback, keeping the current prompt line. */
export function terminalClear(tabId: string): void {
  sessions.get(tabId)?.term.clear();
}

/** Focus the terminal's input. */
export function terminalFocus(tabId: string): void {
  sessions.get(tabId)?.term.focus();
}

/** Find the next match of `query` (wraps). No-op for an empty query. */
export function terminalFindNext(tabId: string, query: string): void {
  if (query) sessions.get(tabId)?.search.findNext(query);
}

/** Find the previous match of `query` (wraps). No-op for an empty query. */
export function terminalFindPrevious(tabId: string, query: string): void {
  if (query) sessions.get(tabId)?.search.findPrevious(query);
}

/** Drop any search highlight/selection left over from a find. */
export function terminalClearSearch(tabId: string): void {
  sessions.get(tabId)?.term.clearSelection();
}

function disposeSession(tabId: string): void {
  const session = sessions.get(tabId);
  if (!session) return;
  session.cleanup();
  session.container.remove();
  sessions.delete(tabId);
}

// Dispose a terminal's PTY + xterm when its tab closes — fires only when the
// set of open terminal tabs changes.
subscribeTabsByKind(
  'terminal',
  (t) => t.id,
  (liveIds) => {
    for (const tabId of [...sessions.keys()]) {
      if (!liveIds.has(tabId)) disposeSession(tabId);
    }
  },
);
