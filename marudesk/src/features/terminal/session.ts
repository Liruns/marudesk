import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { AppSettings } from '../../../shared/settings';
import { resolveTheme, subscribeAppearance, useSettingsStore } from '../settings/store';
import { subscribeTabsByKind } from '../tabs/store';
import { toMessage } from '../../lib/toMessage';

/**
 * Terminal sessions outlive the React component that shows them. Each session
 * owns a detached container that xterm renders into; TerminalView re-parents
 * that container into its host on mount and detaches it on unmount. So
 * switching tabs (or away to a web tab and back) keeps the live shell, its
 * scrollback, and any running process — the PTY is disposed only when the
 * terminal tab actually closes (the prune subscription below, mirroring the
 * editor's model pruning). Keyed by the terminal tab's id.
 */

const TERM_FONT_FALLBACK =
  "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace";

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
  ptyId: string | null;
  cleanup: () => void;
};

const sessions = new Map<string, Session>();

function applyTermSettings(session: Session, s: AppSettings): void {
  const { term, fit } = session;
  term.options.fontFamily =
    s.appearance.terminalFontFamily.trim() || TERM_FONT_FALLBACK;
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
    fontFamily: settings.appearance.terminalFontFamily.trim() || TERM_FONT_FALLBACK,
    fontSize: settings.appearance.terminalFontSize,
    cursorBlink: true,
    theme: xtermTheme(resolveTheme(settings.appearance.theme)),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);

  const session: Session = { container, term, fit, ptyId: null, cleanup: () => {} };
  sessions.set(tabId, session);

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
