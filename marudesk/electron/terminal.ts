import { type BrowserWindow } from 'electron';
import { fileURLToPath } from 'node:url';
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
import { getCompanionConnection, startCompanion } from './server/companion';
import { toMessage } from '../shared/to-message';
import { scrubText } from '../shared/scrub';
import {
  createTerminalErrorDetector,
  stripAnsi,
  type TerminalErrorDetector,
  type TerminalErrorEvent,
} from '../shared/terminal-evidence';
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
  /** Bounded recent output tail (raw bytes) for the agent's read_terminal tool. */
  scrollback: string;
  /**
   * Passive error detection over the output stream (terminal "Fix this").
   * null for the agent-cli profile — the chat CLI quoting errors would be
   * noise, not evidence.
   */
  detector: TerminalErrorDetector | null;
  /** Ring of recent detected errors (already secret-scrubbed), oldest first. */
  errors: TerminalErrorEvent[];
  /** Quiet-period timer that flushes a still-open detector event. */
  errorFlushTimer: NodeJS.Timeout | null;
};

const sessions = new Map<string, Session>();

const DIM_MIN = 1;
const DIM_MAX = 1000;
const MAX_TERMINALS = 64;
const MAX_EARLY_BUFFER_BYTES = 1024 * 1024;
// Recent scrollback kept per session so the agent's `read_terminal` tool can
// read what the shell printed (node-pty streams to the renderer's xterm, which
// main can't query — so we retain a bounded tail here). Raw bytes; the tool
// strips ANSI + scrubs secrets at egress.
const SCROLLBACK_MAX = 16 * 1024;
// Detected-error ring per terminal (terminal "Fix this"): newer events replace
// older ones; there is no shell-integration signal to clear on, so the ring +
// the explicit terminal:clear-errors invoke are the whole lifecycle.
const MAX_ERRORS_PER_TERMINAL = 10;
// Quiet period after which an open detector run is flushed, so an error that is
// the LAST thing a command printed still fires without waiting for more output.
const ERROR_FLUSH_QUIET_MS = 300;

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
    // Untrusted renderer input: only the known profile name is honored.
    profile: o.profile === 'agent-cli' ? 'agent-cli' : undefined,
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
export function resolveShell(override: string | undefined, settingsShell: string): string {
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

export function inheritedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string' && !SENSITIVE_ENV.test(k)) env[k] = v;
  }
  return env;
}

/**
 * The built chat-cli entry (chat CLI v2 — docs/chat-cli-tui-design.md §6.1/§7).
 * It is emitted NEXT TO main.mjs, so resolve from this bundle's own URL — which
 * is correct however the app was launched (npm dev, `electron .`, the e2e
 * harness passing the main script directly, or packaged). Packaged builds swap
 * in the asarUnpacked copy: ELECTRON_RUN_AS_NODE children read plain files,
 * not app.asar (same reason node-pty is unpacked).
 */
export function chatCliEntryPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const base = here.replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked');
  return path.join(base, 'chat-cli.mjs');
}

/**
 * How to run the bundled CLI in a PTY. Plain `node` from PATH when available
 * (a normal console-subsystem binary). Without one: on mac/linux this Electron
 * binary in RUN_AS_NODE mode works fine under a PTY; on Windows it does NOT —
 * electron.exe is a GUI-subsystem image, so under ConPTY its std handles never
 * attach (zero output, no TTY) — wrapping it in cmd.exe (console subsystem)
 * makes the console exist so the child inherits real handles. The cmd line is
 * passed as a STRING because node-pty's argv quoting (`\"`) isn't cmd quoting;
 * `/s /c "…"` is the canonical both-paths-quoted form.
 */
function agentCliCommand(entry: string): { file: string; args: string[] | string } {
  const node = whichShell('node');
  if (node) return { file: node, args: [entry] };
  if (process.platform !== 'win32') return { file: process.execPath, args: [entry] };
  return { file: 'cmd.exe', args: `/d /s /c ""${process.execPath}" "${entry}""` };
}

/**
 * Spawn spec for the `agent-cli` terminal profile: the bundled CLI with the
 * loopback companion's connection injected as env. The injection happens AFTER
 * the inheritedEnv secret-strip on purpose — it is child-only (the CLI
 * process, not a user shell) and never reaches the renderer.
 */
async function resolveAgentCliSpawn(): Promise<{
  file: string;
  args: string[] | string;
  env: Record<string, string>;
  displayName: string;
}> {
  // The companion is started at boot, but be tolerant of a slow/failed boot —
  // starting it here is idempotent.
  let conn = getCompanionConnection();
  if (!conn) {
    await startCompanion();
    conn = getCompanionConnection();
  }
  if (!conn) {
    throw new Error('the CLI bridge (loopback companion) is not running');
  }
  const entry = chatCliEntryPath();
  if (!isExecutableFile(entry)) {
    throw new Error(`chat CLI not found at ${entry} — run a build first`);
  }
  const command = agentCliCommand(entry);
  return {
    file: command.file,
    args: command.args,
    env: {
      ...inheritedEnv(),
      // Only meaningful when the spawned binary is Electron; harmless for node.
      ELECTRON_RUN_AS_NODE: '1',
      MARUDESK_BRIDGE_URL: conn.url,
      MARUDESK_BRIDGE_TOKEN: conn.token,
    },
    displayName: 'marudesk chat',
  };
}

export function registerTerminalHandlers(deps: {
  getMainWindow: () => BrowserWindow | null;
  getWorkspaceRoot: () => string | null;
}): void {
  const sendToRenderer = (
    channel: 'terminal:data' | 'terminal:exit' | 'terminal:error-count',
    payload: unknown,
  ) => {
    const win = deps.getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  defineHandler('terminal:create', async ([raw]) => {
    if (sessions.size >= MAX_TERMINALS) {
      throw new Error('too many open terminals');
    }
    const opts = parseCreate(raw);
    const cwd = resolveCwd(deps.getWorkspaceRoot());

    // Resolve what to spawn: the user's shell, or a named profile main decides
    // (the renderer never passes a command — chat CLI v2 §6.1).
    let file: string;
    let args: string[] | string = [];
    let env = inheritedEnv();
    let displayName: string;
    if (opts.profile === 'agent-cli') {
      const cli = await resolveAgentCliSpawn();
      file = cli.file;
      args = cli.args;
      env = cli.env;
      displayName = cli.displayName;
    } else {
      const settings = await getSettings();
      file = resolveShell(opts.shell, settings.terminal.defaultShell);
      displayName = file;
    }

    let pty: IPty;
    try {
      pty = spawn(file, args, {
        name: 'xterm-256color',
        cols: opts.cols,
        rows: opts.rows,
        cwd,
        env,
      });
    } catch (err) {
      // Surface a shell-specific message (the resolved path + the cause) instead
      // of node-pty's bare `File not found:` — the renderer shows this verbatim.
      const cause = toMessage(err);
      throw new Error(`could not start "${displayName}" (cwd: ${cwd}): ${cause}`, {
        cause: err,
      });
    }

    const id = randomUUID();
    const rec: Session = {
      pty,
      buffer: [],
      buffered: 0,
      ready: false,
      scrollback: '',
      detector: opts.profile === 'agent-cli' ? null : createTerminalErrorDetector(),
      errors: [],
      errorFlushTimer: null,
    };
    sessions.set(id, rec);

    // Intake for detected errors: scrub each excerpt BEFORE it leaves the
    // terminal layer (read_terminal's egress contract), ring-buffer it, and
    // push the fresh count so the renderer badge updates without polling.
    const recordErrors = (events: TerminalErrorEvent[]): void => {
      if (events.length === 0) return;
      for (const ev of events) {
        rec.errors.push({
          ...ev,
          message: scrubText(ev.message),
          excerpt: scrubText(ev.excerpt),
        });
      }
      if (rec.errors.length > MAX_ERRORS_PER_TERMINAL) {
        rec.errors.splice(0, rec.errors.length - MAX_ERRORS_PER_TERMINAL);
      }
      sendToRenderer('terminal:error-count', { id, count: rec.errors.length });
    };

    pty.onData((data) => {
      // Retain a bounded scrollback tail for the agent's read_terminal tool.
      rec.scrollback += data;
      if (rec.scrollback.length > SCROLLBACK_MAX) {
        rec.scrollback = rec.scrollback.slice(-SCROLLBACK_MAX);
      }
      if (rec.detector) {
        recordErrors(rec.detector.push(data));
        // Flush on a quiet period so an error printed last (no trailing output
        // to close the run) still fires.
        if (rec.errorFlushTimer) clearTimeout(rec.errorFlushTimer);
        rec.errorFlushTimer = setTimeout(() => {
          rec.errorFlushTimer = null;
          if (rec.detector && sessions.get(id) === rec) {
            recordErrors(rec.detector.flush());
          }
        }, ERROR_FLUSH_QUIET_MS);
      }
      if (rec.ready) {
        sendToRenderer('terminal:data', { id, data });
      } else if (rec.buffered < MAX_EARLY_BUFFER_BYTES) {
        rec.buffer.push(data);
        rec.buffered += data.length;
      }
    });

    pty.onExit(({ exitCode, signal }) => {
      if (rec.errorFlushTimer) clearTimeout(rec.errorFlushTimer);
      sendToRenderer('terminal:exit', { id, exitCode, signal });
      sessions.delete(id);
    });

    return { id, shell: displayName, cwd } satisfies TerminalCreated;
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

  // Drain the detected-error ring (the badge popover's pull on open). A fresh
  // array each call; empty when the session is gone. Already scrubbed at intake.
  defineHandler('terminal:pull-errors', ([raw]) => {
    const rec = sessions.get(parseId(raw));
    return rec ? [...rec.errors] : [];
  });

  defineHandler('terminal:clear-errors', ([raw]) => {
    const id = parseId(raw);
    const rec = sessions.get(id);
    if (!rec) return;
    rec.errors = [];
    sendToRenderer('terminal:error-count', { id, count: 0 });
  });
}

function killSession(id: string): void {
  const rec = sessions.get(id);
  if (!rec) return;
  if (rec.errorFlushTimer) clearTimeout(rec.errorFlushTimer);
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

// ANSI stripping lives in shared/terminal-evidence.ts (stripAnsi) so the error
// detector and the read_terminal egress strip identically.

/**
 * Recent output of the most-recently-created live terminal, ANSI-stripped and
 * tail-trimmed, for the agent's `read_terminal` tool. Returns null when no
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
  const stripped = stripAnsi(rec.scrollback);
  const output = stripped.length > maxChars ? stripped.slice(-maxChars) : stripped;
  return { count: sessions.size, output };
}

/**
 * Enumerate the live terminals (insertion order — oldest first, newest last) with
 * a size hint, for the agent's `list_terminals` context tool. Ids are the same
 * ones `read_terminal` / `getTerminalOutput` accept.
 */
export function getTerminalList(): { id: string; bytes: number; lines: number }[] {
  return [...sessions.entries()].map(([id, rec]) => {
    const stripped = stripAnsi(rec.scrollback);
    return {
      id,
      bytes: stripped.length,
      lines: stripped ? stripped.split('\n').length : 0,
    };
  });
}

/**
 * Recent scrollback of a SPECIFIC terminal by id, ANSI-stripped + tail-trimmed
 * (for `read_terminal`). Returns null when no such terminal is live. The tool
 * scrubs secrets at egress.
 */
export function getTerminalOutput(
  id: string,
  maxChars = 8000,
): { output: string } | null {
  const rec = sessions.get(id);
  if (!rec) return null;
  const stripped = stripAnsi(rec.scrollback);
  const output = stripped.length > maxChars ? stripped.slice(-maxChars) : stripped;
  return { output };
}
