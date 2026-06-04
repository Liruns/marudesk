import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { utilityProcess } from 'electron';
import type { HostChannel } from './rpc';
import { sandboxExecArgv, type SpawnWorker } from './transport';

/**
 * Production spawn backend: run the plugin worker as an Electron `utilityProcess`
 * (docs/plugin-runtime-design.md §3, §3.2). Kept in its own module so the
 * Electron import never reaches the transport/host/worker — those stay portable so
 * the headless harness can drive the same worker via `child_process` (design §R1).
 *
 * The worker is sandboxed at the runtime via {@link sandboxExecArgv} (Node
 * Permission Model: fs/child_process/worker denied except the plugin's own folder
 * for reads), layered on top of the always-on Module._load shim inside the worker.
 */

const WORKER_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'plugin-worker.mjs');

export const spawnViaUtilityProcess: SpawnWorker = ({ pluginDir, granted }) => {
  const child = utilityProcess.fork(WORKER_ENTRY, [], {
    cwd: pluginDir,
    serviceName: `plugin:${path.basename(pluginDir)}`,
    env: {}, // the worker inherits nothing from the parent environment
    execArgv: sandboxExecArgv(pluginDir, granted),
  });
  const channel: HostChannel = {
    postMessage: (message) => child.postMessage(message),
    onMessage: (listener) => {
      const fn = (message: unknown): void => listener(message as never);
      child.on('message', fn);
      return () => {
        child.off('message', fn);
      };
    },
    onClose: (listener) => {
      child.on('exit', listener);
      return () => {
        child.off('exit', listener);
      };
    },
    kill: () => {
      child.kill();
    },
  };
  return { channel };
};

/** The built worker entry path, exported for diagnostics / tests. */
export { WORKER_ENTRY };
