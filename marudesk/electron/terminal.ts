import { type BrowserWindow } from 'electron';
// Named import verified against node-pty 1.1.0: its CJS entry sets
// `exports.spawn` + `__esModule`, which Node's cjs-module-lexer detects, so
// `import { spawn }` resolves through the ESM→CJS interop in the built
// main.mjs. Re-check on a node-pty major upgrade.
import { spawn, type IPty } from 'node-pty';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
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
  /** Bounded recent output tail (raw bytes) for the agent's terminal_output tool. */
  scrollback: string;
};

const sessions = new Map<string, Session>();

const DIM_MIN = 1;
const DIM_MAX = 1000;
const MAX_TERMINALS = 64;
const MAX_EARLY_BUFFER_BYTES = 1024 * 1024;
// Recent scrollback kept per session so the agent's `terminal_output` tool can
// read what the shell printed (node-pty streams to the renderer's xterm, which
// main can't query — so we retain a bounded tail here). Raw bytes; the tool
// strips ANSI + scrubs secrets at egress.
const SCROLLBACK_MAX = 16 * 1024;

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

// Values that older/foreign builds (or a hand-edited file) persisted as a
// "shell" but that aren't real executables — treat them as "use the OS default"
// instead of handing them to node-pty, which would fail with a bare
// `File not found:` (the exact symptom this guards against). `sanitizeSettings`
// also maps these to '' on the settings side; this is the main-process backstop.
const SHELL_SENTINELS = new Set(['system', 'default', 'os', 'auto', 'none']);

function isShellSentinel(value: string): boolean {
  return SHELL_SENTINELS.has(value.trim().toLowerCase());
}

function isExecutableFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * `which`-style resolution: turn a shell name or path into an absolute path to
 * an existing executable, or null if it can't be found. Mirrors how a shell
 * locates a command — an absolute/relative path is checked directly, a bare name
 * is searched across PATH — and on Windows also tries the PATHEXT suffixes
 * (`.EXE`/`.CMD`/…) so `powershell`/`pwsh` resolve without the extension. We
 * resolve to a full path up front so spawning never depends on node-pty's own
 * lookup (the source of the cryptic `File not found:` errors).
 */
function whichShell(cmd: string): string | null {
  const trimmed = cmd.trim();
  if (!trimmed) return null;

  const isWin = process.platform === 'win32';
  const exts = isWin
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  // Only skip the suffix search when the name already ends in a *real* executable
  // extension — not merely "has a dot", so a versioned name like `python3.11`
  // (extname `.11`) still gets `.EXE`/`.CMD`/… appended.
  const upper = trimmed.toUpperCase();
  const hasExeExt = isWin && exts.some((ext) => upper.endsWith(ext.toUpperCase()));
  const tryWithExts = (base: string): string | null => {
    if (isExecutableFile(base)) return base;
    if (isWin && !hasExeExt) {
      for (const ext of exts) {
        if (isExecutableFile(base + ext)) return base + ext;
      }
    }
    return null;
  };

  // An explicit path (absolute, or containing a separator) is checked as-is.
  if (path.isAbsolute(trimmed) || trimmed.includes('/') || (isWin && trimmed.includes('\\'))) {
    return tryWithExts(path.resolve(trimmed));
  }

  // A bare command name is searched across PATH, like the OS would.
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const hit = tryWithExts(path.join(dir, trimmed));
    if (hit) return hit;
  }
  return null;
}

/**
 * Pick the shell as an ordered fallback chain: an explicit per-terminal
 * override, then the user's settings default, then per-platform defaults
 * (PowerShell→cmd on Windows, $SHELL→zsh/bash→sh on Unix). The first candidate
 * that resolves to a real executable wins, so a missing/invalid configured shell
 * (e.g. `pwsh` not installed, or a stale `"system"` value) degrades to a working
 * shell instead of failing the whole terminal. The configured shell is still the
 * user's own choice — same trust model as VSCode's `terminal.integrated.shell`.
 */
function resolveShell(override: string | undefined, settingsShell: string): string {
  const candidates: string[] = [];
  const add = (value: string | undefined | null): void => {
    if (value && value.trim() && !isShellSentinel(value)) candidates.push(value.trim());
  };

  add(override);
  add(settingsShell);
  if (process.platform === 'win32') {
    add('powershell.exe');
    add(process.env.ComSpec);
    add('cmd.exe');
  } else if (process.platform === 'darwin') {
    add(process.env.SHELL);
    add('/bin/zsh');
    add('/bin/bash');
    add('/bin/sh');
  } else {
    add(process.env.SHELL);
    add('/bin/bash');
    add('/bin/sh');
  }

  for (const candidate of candidates) {
    const resolved = whichShell(candidate);
    if (resolved) return resolved;
  }
  // Nothing resolved (extremely unlikely). Hand the hard platform default to
  // node-pty unresolved so any resulting error names a real default shell.
  return process.platform === 'win32'
    ? process.env.ComSpec || 'cmd.exe'
    : process.env.SHELL || '/bin/sh';
}

/**
 * The PTY's working directory: the open workspace root, else the user's home.
 * Each candidate is verified to be an existing directory before use — a stale or
 * deleted workspace root would otherwise make node-pty fail with
 * `Cannot create process, error code: 267` (ERROR_DIRECTORY).
 */
function resolveCwd(root: string | null): string {
  for (const candidate of [root, os.homedir(), process.cwd()]) {
    if (!candidate) continue;
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // Not accessible — try the next candidate.
    }
  }
  return os.homedir();
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
    const cwd = resolveCwd(deps.getWorkspaceRoot());

    let pty: IPty;
    try {
      pty = spawn(shell, [], {
        name: 'xterm-256color',
        cols: opts.cols,
        rows: opts.rows,
        cwd,
        env: inheritedEnv(),
      });
    } catch (err) {
      // Surface a shell-specific message (the resolved path + the cause) instead
      // of node-pty's bare `File not found:` — the renderer shows this verbatim.
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(`could not start shell "${shell}" (cwd: ${cwd}): ${cause}`, {
        cause: err,
      });
    }

    const id = randomUUID();
    const rec: Session = { pty, buffer: [], buffered: 0, ready: false, scrollback: '' };
    sessions.set(id, rec);

    pty.onData((data) => {
      // Retain a bounded scrollback tail for the agent's terminal_output tool.
      rec.scrollback += data;
      if (rec.scrollback.length > SCROLLBACK_MAX) {
        rec.scrollback = rec.scrollback.slice(-SCROLLBACK_MAX);
      }
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

// CSI (colors/cursor) + OSC (window-title) escape sequences, stripped before the
// scrollback is handed to the agent so it reads plain text.
const ANSI_ESCAPE =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/**
 * Recent output of the most-recently-created live terminal, ANSI-stripped and
 * tail-trimmed, for the agent's `terminal_output` tool. Returns null when no
 * terminal is open. (Main has no notion of the "focused" terminal; the newest
 * session is the best heuristic for "the one the user is looking at".)
 */
export function getRecentTerminalOutput(
  maxChars = 8000,
): { count: number; output: string } | null {
  if (sessions.size === 0) return null;
  const ids = [...sessions.keys()];
  const rec = sessions.get(ids[ids.length - 1]);
  if (!rec) return null;
  const stripped = rec.scrollback.replace(ANSI_ESCAPE, '');
  const output = stripped.length > maxChars ? stripped.slice(-maxChars) : stripped;
  return { count: sessions.size, output };
}
