import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { InvokeChannel, IpcMap } from '../../shared/ipc';
import type { WorkspaceSummary } from '../../shared/workspace';
import { toMessage } from '../../shared/to-message';

/**
 * The single place IPC invoke handlers are registered. {@link defineHandler}:
 *   - types the handler's return value against the channel's {@link IpcMap}
 *     result, so a handler can never drift from the renderer-facing contract;
 *   - prefixes any thrown error with the channel name (unless it already carries
 *     the low-level `marudesk:` prefix from fs-safe), so the terse messages from
 *     validate.ts read as `'<channel>: <message>'` on the renderer side;
 *   - passes the raw, still-untrusted args array through for explicit validation.
 *
 * {@link requireWorkspace} centralizes the "no workspace is open" guard that
 * every workspace-touching channel previously re-implemented (with two different
 * message conventions). Call {@link setWorkspaceProvider} once at startup.
 */

type Res<C extends InvokeChannel> = IpcMap[C]['result'];

let getWorkspace: (() => WorkspaceSummary | null) | null = null;

/** Wire the current-workspace accessor exactly once (from main.ts). */
export function setWorkspaceProvider(fn: () => WorkspaceSummary | null): void {
  getWorkspace = fn;
}

/** Resolve the open workspace or throw the one canonical "no workspace" error. */
export function requireWorkspace(): { ws: WorkspaceSummary; root: string } {
  const ws = getWorkspace?.() ?? null;
  if (!ws) throw new Error('no workspace is open');
  return { ws, root: ws.root };
}

export function defineHandler<C extends InvokeChannel>(
  channel: C,
  handler: (
    args: unknown[],
    event: IpcMainInvokeEvent,
  ) => Res<C> | Promise<Res<C>>,
): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    try {
      return await handler(args, event);
    } catch (err) {
      const msg = toMessage(err);
      // fs-safe and other low-level invariants already namespace with
      // `marudesk:`; only add the channel prefix when the message is bare.
      throw new Error(msg.startsWith('marudesk:') ? msg : `${channel}: ${msg}`, {
        cause: err,
      });
    }
  });
}
