import { fork as forkChild } from 'node:child_process';
import path from 'node:path';
import type { PluginPermission } from '../../shared/plugin';
import type { HostChannel } from './rpc';

/**
 * Spawn-backend abstraction for the plugin worker (docs/plugin-runtime-design.md
 * §3, §3.2). Production uses Electron's `utilityProcess.fork`; the headless
 * harness uses `child_process.fork`. Both run the SAME Electron-free worker module
 * and expose a structured-message channel, so the rest of the host is
 * transport-agnostic — it only ever sees a {@link HostChannel}.
 *
 * Defense-in-depth has two layers (design §3.2): (1) the always-on `Module._load`
 * shim INSIDE the worker (denies net/child_process modules) — active in both
 * backends; (2) the Node Permission Model flags via `execArgv` — applied by the
 * production `utilityProcess` backend (see {@link sandboxExecArgv}). The harness's
 * `child_process` backend deliberately omits `--permission` because it runs the
 * worker as TypeScript under `--experimental-strip-types`, whose source files live
 * outside the plugin folder and would be blocked by the permission model; the
 * harness therefore asserts the shim layer, and production asserts the permission
 * layer. The shim is the cross-cutting defense present everywhere.
 */

/**
 * Build the Node Permission Model `execArgv` for the PRODUCTION (`utilityProcess`)
 * spawn: deny fs/child_process/worker at the runtime, allowing only the plugin's
 * own folder for reads. `fs:write` is P3; when it lands, add `--allow-fs-write`.
 */
export function sandboxExecArgv(pluginDir: string, granted: PluginPermission[]): string[] {
  const argv = ['--permission', `--allow-fs-read=${pluginDir}`];
  if (granted.includes('fs:write')) argv.push(`--allow-fs-write=${pluginDir}`);
  return argv;
}

/** A spawned worker plus the host-side channel to drive it. */
export type SpawnedWorker = { channel: HostChannel };

/** How the host spawns a worker — injectable so the harness can swap backends. */
export type SpawnWorker = (opts: {
  workerEntry: string;
  pluginDir: string;
  granted: PluginPermission[];
}) => SpawnedWorker;

/**
 * Default spawn over `child_process.fork`. This is what the headless harness uses
 * directly; production overrides it with a `utilityProcess` backend wired in the
 * Electron host (utilityProcess can't be imported here without pulling Electron
 * into this otherwise-portable module). Kept here so the worker contract (entry +
 * execArgv + IPC) lives in one place.
 */
export const spawnViaChildProcess: SpawnWorker = ({ workerEntry, pluginDir }) => {
  const child = forkChild(workerEntry, [], {
    cwd: pluginDir,
    // Pass only cwd-independent TS flags to the child. The worker's own repo
    // imports are all type-only (erased at runtime), so it needs nothing but
    // strip-types; we must NOT inherit a relative `--import`/`--require` loader
    // flag (it would resolve against the child's plugin-dir cwd and fail). The
    // Module._load shim inside the worker is the active sandbox for this backend;
    // production uses utilityProcess + sandboxExecArgv (above).
    execArgv: process.execArgv.filter((a) => a.startsWith('--experimental-')),
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const channel: HostChannel = {
    postMessage: (message) => child.send(message),
    onMessage: (listener) => {
      const fn = (msg: unknown): void => listener(msg as never);
      child.on('message', fn);
      return () => child.off('message', fn);
    },
    onClose: (listener) => {
      child.on('exit', listener);
      return () => child.off('exit', listener);
    },
    kill: () => {
      child.kill();
    },
  };
  return { channel };
};

/** Resolve the built worker entry path next to this module's output. */
export function defaultWorkerEntry(dir: string): string {
  return path.join(dir, 'plugin-worker.mjs');
}
