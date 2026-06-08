import path from 'node:path';
import { spawn, type IPty } from 'node-pty';
import type { BrowserWindow } from 'electron';
import { defineHandler, requireWorkspace } from './ipc/define-handler';
import { obj, str } from './ipc/validate';
import { getSettingsSync } from './settings';
import { inheritedEnv, resolveShell } from './terminal';
import { listWorktrees } from './git-worktree';
import { createAndActivateTab } from './browser/tabs';
import type { LaneDevStartResult, LaneDevState, LaneDevStatus } from '../shared/lanes';

/**
 * Per-lane dev server manager (§3.8). Spawns the workspace's configured dev
 * command (a node-pty so colored/long-running dev servers behave) inside a
 * worktree lane's directory, scrapes the first localhost URL out of its output,
 * and exposes start/stop/list + a live `lanes:dev-state` push. Keyed by the
 * worktree path. All processes are killed on quit.
 */

type LaneProc = { pty: IPty; state: LaneDevState; output: string };

const procs = new Map<string, LaneProc>();
const OUTPUT_CAP = 16_000;
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+(?:\/\S*)?/i;

let listener: ((states: LaneDevState[]) => void) | null = null;
export function setLaneDevListener(fn: (states: LaneDevState[]) => void): void {
  listener = fn;
}

function snapshot(): LaneDevState[] {
  return [...procs.values()].map((p) => ({ ...p.state }));
}
function push(): void {
  listener?.(snapshot());
}

/** Shell argv to run a single command string, per platform. */
function commandArgs(shell: string, command: string): string[] {
  const base = path.basename(shell).toLowerCase();
  if (base.includes('powershell') || base.includes('pwsh')) {
    return ['-NoLogo', '-NoProfile', '-Command', command];
  }
  if (base.includes('cmd')) return ['/d', '/s', '/c', command];
  return ['-lc', command];
}

function normalizeUrl(raw: string): string {
  return raw.replace('0.0.0.0', 'localhost').replace(/\/$/, '');
}

function startDevServer(lanePath: string, command: string): LaneDevStartResult {
  if (procs.has(lanePath)) return { ok: false, reason: 'already-running' };
  const shell = resolveShell(undefined, getSettingsSync().terminal.defaultShell);
  const pty = spawn(shell, commandArgs(shell, command), {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: lanePath,
    env: inheritedEnv(),
  });
  const rec: LaneProc = {
    pty,
    output: '',
    state: { path: lanePath, status: 'starting', url: null, exitCode: null },
  };
  procs.set(lanePath, rec);
  push();

  pty.onData((data) => {
    rec.output = (rec.output + data).slice(-OUTPUT_CAP);
    let changed = false;
    if (rec.state.status === 'starting') {
      rec.state.status = 'running';
      changed = true;
    }
    if (!rec.state.url) {
      const m = rec.output.match(URL_RE);
      if (m) {
        rec.state.url = normalizeUrl(m[0]);
        changed = true;
      }
    }
    if (changed) push();
  });

  pty.onExit(({ exitCode }) => {
    rec.state.status = 'exited';
    rec.state.exitCode = exitCode;
    push();
    procs.delete(lanePath);
    push();
  });
  return { ok: true };
}

function stopDevServer(lanePath: string): boolean {
  const rec = procs.get(lanePath);
  if (!rec) return false;
  try {
    rec.pty.kill();
  } catch {
    // already gone
  }
  return true;
}

export function disposeAllLaneDevServers(): void {
  for (const rec of procs.values()) {
    try {
      rec.pty.kill();
    } catch {
      // ignore
    }
  }
  procs.clear();
}

/** Resolve `target` to a real worktree of the active repo (guards arbitrary cwd). */
async function resolveLane(target: string): Promise<string | null> {
  const root = requireWorkspace().root;
  const trees = await listWorktrees(root).catch(() => []);
  const wt = trees.find((w) => path.resolve(w.path) === path.resolve(target));
  return wt ? wt.path : null;
}

export function registerLaneDevHandlers(deps: { getMainWindow: () => BrowserWindow | null }): void {
  setLaneDevListener((states) => {
    const win = deps.getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('lanes:dev-state', states);
  });

  defineHandler('lanes-dev:list', () => snapshot());

  defineHandler('lanes-dev:start', async ([payload]): Promise<LaneDevStartResult> => {
    const target = str(obj(payload).path, 'path');
    const command = getSettingsSync().lanes.devCommand.trim();
    if (!command) return { ok: false, reason: 'no-command' };
    const lane = await resolveLane(target);
    if (!lane) return { ok: false, reason: 'not-a-lane' };
    return startDevServer(lane, command);
  });

  defineHandler('lanes-dev:stop', ([payload]) => stopDevServer(str(obj(payload).path, 'path')));

  defineHandler('lanes-dev:open', ([payload]) => {
    const target = str(obj(payload).path, 'path');
    const rec = procs.get(target);
    if (!rec || !rec.state.url) return false;
    createAndActivateTab('web', rec.state.url);
    return true;
  });
}

/** Exposed for the status type re-use elsewhere. */
export type { LaneDevState, LaneDevStatus };
