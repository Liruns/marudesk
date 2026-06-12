import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { defineHandler } from './ipc/define-handler';
import { chatCliEntryPath } from './terminal';
import type { CliCommandStatus } from '../shared/terminal';

/**
 * The `marudesk` terminal command: a small shim script on the user's PATH that
 * launches the bundled chat CLI (cli/main.ts via dist-electron/chat-cli.mjs).
 * The CLI itself finds the running app through the loopback companion's
 * cli-bridge.json handshake (cli/config.ts), so the shim needs no tokens —
 * just a way to run the entry under a Node runtime:
 *
 *  - `node` from PATH when available (a real console-subsystem binary —
 *    required on Windows, where electron.exe is a GUI-subsystem image whose
 *    std handles never attach under a plain console).
 *  - else this Electron binary with ELECTRON_RUN_AS_NODE (mac/linux only).
 *
 * Install targets (no elevation, ever):
 *  - Windows: %LOCALAPPDATA%\marudesk\bin\marudesk.cmd, with that directory
 *    appended to the *user* PATH (HKCU) via PowerShell so new terminals see it.
 *  - macOS/Linux: /usr/local/bin/marudesk when writable, else ~/.local/bin.
 *
 * Installation is idempotent and re-run at boot (ensureCliCommand) so the shim
 * follows the app across updates (the entry path is baked in at install time).
 */

const execFileAsync = promisify(execFile);

const SHIM_NAME = process.platform === 'win32' ? 'marudesk.cmd' : 'marudesk';

function windowsBinDir(): string {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'marudesk', 'bin');
}

/** Candidate install directories, preferred first. */
function candidateDirs(): string[] {
  if (process.platform === 'win32') return [windowsBinDir()];
  return ['/usr/local/bin', path.join(os.homedir(), '.local', 'bin')];
}

function isOnPath(dir: string): boolean {
  const entries = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const normalized = path.resolve(dir);
  return entries.some((e) => {
    try {
      return path.resolve(e) === normalized;
    } catch {
      return false;
    }
  });
}

function shimContent(entry: string): string {
  if (process.platform === 'win32') {
    return [
      '@echo off',
      'rem marudesk terminal command - chats with the running marudesk desktop app.',
      'setlocal',
      'set "ELECTRON_RUN_AS_NODE=1"',
      'where node >nul 2>nul',
      'if %errorlevel%==0 (',
      `  node "${entry}" %*`,
      ') else (',
      `  "${process.execPath}" "${entry}" %*`,
      ')',
      '',
    ].join('\r\n');
  }
  return [
    '#!/bin/sh',
    '# marudesk terminal command - chats with the running marudesk desktop app.',
    'if command -v node >/dev/null 2>&1; then',
    `  exec node "${entry}" "$@"`,
    'fi',
    `ELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${entry}" "$@"`,
    '',
  ].join('\n');
}

/** Where the shim is currently installed, if anywhere. */
function findInstalled(): string | null {
  for (const dir of candidateDirs()) {
    const p = path.join(dir, SHIM_NAME);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      // keep looking
    }
  }
  return null;
}

export function cliCommandStatus(): CliCommandStatus {
  const installed = findInstalled();
  return {
    installed: installed !== null,
    path: installed,
    onPath: installed !== null && isOnPath(path.dirname(installed)),
  };
}

/**
 * Append the shim directory to the per-user PATH on Windows (HKCU — no
 * elevation, broadcasts the change so new shells pick it up). PowerShell's
 * SetEnvironmentVariable is used instead of `setx`, which truncates >1024
 * chars. The current process env is updated too so status reads true at once.
 */
async function addToWindowsUserPath(dir: string): Promise<void> {
  const script =
    `$dir = ${JSON.stringify(dir)}; ` +
    `$cur = [Environment]::GetEnvironmentVariable('Path', 'User'); ` +
    `if ($null -eq $cur) { $cur = '' } ` +
    `$parts = $cur -split ';' | Where-Object { $_ -ne '' }; ` +
    `if (-not ($parts -contains $dir)) { ` +
    `[Environment]::SetEnvironmentVariable('Path', (($parts + $dir) -join ';'), 'User') }`;
  await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ]);
  if (!isOnPath(dir)) {
    process.env.PATH = `${process.env.PATH || ''}${path.delimiter}${dir}`;
  }
}

export async function installCliCommand(): Promise<CliCommandStatus> {
  const entry = chatCliEntryPath();
  try {
    if (!fs.statSync(entry).isFile()) throw new Error('missing');
  } catch {
    return {
      installed: false,
      path: null,
      onPath: false,
      error: `chat CLI not found at ${entry} — run a build first`,
    };
  }

  const content = shimContent(entry);
  let lastError = '';
  for (const dir of candidateDirs()) {
    const target = path.join(dir, SHIM_NAME);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(target, content, { mode: 0o755 });
      if (process.platform !== 'win32') fs.chmodSync(target, 0o755);
      if (process.platform === 'win32' && !isOnPath(dir)) {
        await addToWindowsUserPath(dir);
      }
      return { installed: true, path: target, onPath: isOnPath(dir) };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return { installed: false, path: null, onPath: false, error: lastError };
}

/**
 * Boot-time best effort: install the shim when missing, and refresh it when
 * its baked-in entry path went stale (the app moved/updated). Never throws —
 * a read-only bin dir just leaves the Settings button as the manual path.
 */
export async function ensureCliCommand(): Promise<void> {
  try {
    const existing = findInstalled();
    if (existing) {
      const current = fs.readFileSync(existing, 'utf8');
      if (current === shimContent(chatCliEntryPath())) return;
    }
    await installCliCommand();
  } catch {
    // Best effort only.
  }
}

export function registerCliCommandHandlers(): void {
  defineHandler('cli:command-status', () => cliCommandStatus());
  defineHandler('cli:command-install', () => installCliCommand());
}
