import { type BrowserWindow } from 'electron';
// Named import verified against node-pty 1.1.0: its CJS entry sets
// `exports.spawn` + `__esModule`, which Node's cjs-module-lexer detects, so
// `import { spawn }` resolves through the ESM→CJS interop in the built
// main.mjs. Re-check on a node-pty major upgrade.
import { spawn, type IPty } from 'node-pty';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { getSettings } from './settings';
import { defineHandler } from './ipc/define-handler';
import type {
  TerminalCreateOptions,
  TerminalCreated,
  TerminalInput,
  TerminalResize,
} from '../shared/terminal';

/**
 * PTY sessions for the integrated terminal. xterm.js (renderer) drives these
 * over IPC; node-pty does the real work here in main, where process spawning
 * belongs. Embedded web content can't reach these channels — it runs in a
 * separate session with no `marudesk` bridge — so only the trusted renderer
 * (and thus the user) ever creates a terminal.
 */

type Session = {
  pty: IPty;
  // Output produced before the renderer has wired its 'terminal:data' listener
  // is buffered until it sends 'terminal:ready'; otherwise the shell's first
  // prompt/banner (notably ConPTY's init sequence) races the create round-trip
  // and is lost. Capped so a renderer that never readies can't grow it without
  // bound.
  buffer: string[];
  buffered: number;
  ready: boolean;
};

const sessions = new Map<string, Session>();

const DIM_MIN = 1;
const DIM_MAX = 1000;
const MAX_TERMINALS = 64;
const MAX_EARLY_BUFFER_BYTES = 1024 * 1024;

// Strip secret-shaped vars so a user command (`env`, `Get-ChildItem Env:`) and
// any subprocess can't read them. The shell still inherits PATH/HOME/etc. — a
// real terminal needs those — so this is inherit-minus-secrets, not an empty
// env. (Provider keys live in the OS keychain via safeStorage, not process.env;
// this is defense-in-depth in case that ever changes.)
const SENSITIVE_ENV = /(_API_KEY|_TOKEN|_SECRET|_PASSWORD|^ANTHROPIC_)/i;

function clampDim(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(DIM_MAX, Math.max(DIM_MIN, Math.floor(value)));
}

function parseCreate(raw: unknown): TerminalCreateOptions {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    cols: clampDim(o.cols, 80),
    rows: clampDim(o.rows, 24),
    shell: typeof o.shell === 'string' ? o.shell : undefined,
  };
}

function parseInput(raw: unknown): TerminalInput {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.data !== 'string') {
    throw new Error('{ id, data } required');
  }
  return { id: o.id, data: o.data };
}

function parseResize(raw: unknown): TerminalResize {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (typeof o.id !== 'string') {
    throw new Error('id required');
  }
  return { id: o.id, cols: clampDim(o.cols, 80), rows: clampDim(o.rows, 24) };
}

function parseId(raw: unknown): string {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (typeof o.id === 'string') return o.id;
  if (typeof raw === 'string') return raw;
  throw new Error('id required');
}

/**
 * Pick the shell: an explicit per-terminal override, else the user's settings
 * default, else a per-platform default (PowerShell on Windows, $SHELL/zsh on
 * macOS, $SHELL/bash on Linux). This is the user's own choice — the same trust
 * model as VSCode's `terminal.integrated.shell`.
 */
function resolveShell(override: string | undefined, settingsShell: string): string {
  const explicit = (override ?? '').trim() || settingsShell.trim();
  if (explicit) return explicit;
  if (process.platform === 'win32') return 'powershell.exe';
  if (process.platform === 'darwin') return process.env.SHELL || '/bin/zsh';
  return process.env.SHELL || '/bin/bash';
}

function inheritedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string' && !SENSITIVE_ENV.test(k)) env[k] = v;
  }
  return env;
}

export function registerTerminalHandlers(deps: {
  getMainWindow: () => BrowserWindow | null;
  getWorkspaceRoot: () => string | null;
}): void {
  const sendToRenderer = (channel: 'terminal:data' | 'terminal:exit', payload: unknown) => {
    const win = deps.getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  defineHandler('terminal:create', async ([raw]) => {
    if (sessions.size >= MAX_TERMINALS) {
      throw new Error('too many open terminals');
    }
    const opts = parseCreate(raw);
    const settings = await getSettings();
    const shell = resolveShell(opts.shell, settings.terminal.defaultShell);
    const cwd = deps.getWorkspaceRoot() ?? os.homedir();

    const pty = spawn(shell, [], {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd,
      env: inheritedEnv(),
    });

    const id = randomUUID();
    const rec: Session = { pty, buffer: [], buffered: 0, ready: false };
    sessions.set(id, rec);

    pty.onData((data) => {
      if (rec.ready) {
        sendToRenderer('terminal:data', { id, data });
      } else if (rec.buffered < MAX_EARLY_BUFFER_BYTES) {
        rec.buffer.push(data);
        rec.buffered += data.length;
      }
    });

    pty.onExit(({ exitCode, signal }) => {
      sendToRenderer('terminal:exit', { id, exitCode, signal });
      sessions.delete(id);
    });

    return { id } satisfies TerminalCreated;
  });

  // The renderer calls this once it has attached its 'terminal:data' listener,
  // so buffered early output is flushed in order with nothing lost.
  defineHandler('terminal:ready', ([raw]) => {
    const id = parseId(raw);
    const rec = sessions.get(id);
    if (!rec || rec.ready) return;
    rec.ready = true;
    const win = deps.getMainWindow();
    if (win && !win.isDestroyed()) {
      for (const data of rec.buffer) {
        win.webContents.send('terminal:data', { id, data });
      }
    }
    rec.buffer = [];
    rec.buffered = 0;
  });

  defineHandler('terminal:input', ([raw]) => {
    const { id, data } = parseInput(raw);
    sessions.get(id)?.pty.write(data);
  });

  defineHandler('terminal:resize', ([raw]) => {
    const { id, cols, rows } = parseResize(raw);
    sessions.get(id)?.pty.resize(cols, rows);
  });

  defineHandler('terminal:dispose', ([raw]) => {
    killSession(parseId(raw));
  });
}

function killSession(id: string): void {
  const rec = sessions.get(id);
  if (!rec) return;
  try {
    rec.pty.kill();
  } catch {
    // Already gone.
  }
  sessions.delete(id);
}

/** Kill every live PTY — call on window close / before quit. */
export function disposeAllTerminals(): void {
  for (const id of [...sessions.keys()]) killSession(id);
}
