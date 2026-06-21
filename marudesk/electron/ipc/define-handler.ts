import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { InvokeChannel, IpcMap } from '../../shared/ipc';
import type { WorkspaceSummary } from '../../shared/workspace';
import { toScrubbedMessage } from '../../shared/to-message';

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

/**
 * The EXACT URL the host window loaded — the single trusted document. Wired once
 * from main.ts (where it is computed for `will-navigate` pinning) via
 * {@link setTrustedEntryUrl}. Used to authenticate the SENDER of every
 * privileged `invoke`: only the host renderer's top frame (which loaded this
 * entry) may reach these handlers. Null until wired; while null we fail OPEN
 * (accept) so IPC can never regress during the window between handler
 * registration and the entry being set — by the time a renderer can call any
 * handler, the entry is set, so this only covers the pre-load gap.
 */
let trustedEntryUrl: string | null = null;

/**
 * Pin the trusted host entry URL exactly once (from main.ts, alongside the
 * `will-navigate` guard that uses the same value).
 */
export function setTrustedEntryUrl(url: string): void {
  trustedEntryUrl = url;
}

/**
 * Decide whether an `invoke` whose sender frame reports `senderUrl` is the
 * trusted host frame, given the `entryUrl` the host window loaded. Pure + total:
 * any unparseable input is rejected. Mirrors {@link isAllowedHostNavigation}'s
 * boundary — trusted iff same origin AND same pathname (hash/search may differ
 * for client-side routing on the entry document). An embedded `<webview>` /
 * `WebContentsView` browser tab (a different origin or a different local file)
 * is therefore NOT trusted, even though it also lacks the privileged preload.
 */
export function isTrustedSenderFrame(senderUrl: string, entryUrl: string): boolean {
  let sender: URL;
  let entry: URL;
  try {
    sender = new URL(senderUrl);
    entry = new URL(entryUrl);
  } catch {
    return false;
  }
  return sender.origin === entry.origin && sender.pathname === entry.pathname;
}

/**
 * The full sender-authorization decision for a privileged `invoke`, factored out
 * as a pure + total predicate so the empty-url contract is testable.
 *
 * Contract:
 *   - `entryUrl === null` (pre-wire window): fail OPEN — accept any sender,
 *     including an empty/absent one. This only spans the gap between handler
 *     registration and {@link setTrustedEntryUrl}; by the time a renderer can
 *     reach a handler the entry is set (verified by boot ordering), so no real
 *     IPC depends on this branch — it just guarantees boot can never regress.
 *   - `entryUrl !== null` (window loaded): a legitimate privileged call ALWAYS
 *     carries a non-empty sender URL (the host top frame loaded `entryUrl`).
 *     So an empty/absent `senderUrl` is treated as untrusted and REJECTED
 *     (fail CLOSED), as is any non-empty URL that is not the trusted frame. This
 *     closes the opaque-origin / `data:` / `about:blank` empty-url hole where a
 *     frame reports no URL.
 */
export function isAuthorizedSender(
  senderUrl: string | undefined,
  entryUrl: string | null,
): boolean {
  if (entryUrl === null) return true;
  if (typeof senderUrl !== 'string' || senderUrl.length === 0) return false;
  return isTrustedSenderFrame(senderUrl, entryUrl);
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
    // Sender authentication: a privileged handler must only run for the trusted
    // host frame (the BrowserWindow top frame that loaded the app entry). The
    // embedded browser tabs run as separate WebContents without the privileged
    // preload, so this is defense-in-depth — but it closes the door entirely if
    // any embedded frame ever obtained a reference to the bridge. See
    // {@link isAuthorizedSender} for the contract: once the trusted entry is
    // wired we fail CLOSED, rejecting any sender that is foreign OR reports an
    // empty/absent URL (an opaque-origin / `data:` / `about:blank` frame, or a
    // disposed frame). We fail OPEN only while the entry is not yet wired
    // (pre-load gap), so legitimate IPC is never regressed at boot.
    const entryUrl = trustedEntryUrl;
    const senderUrl = event.senderFrame?.url;
    if (!isAuthorizedSender(senderUrl, entryUrl)) {
      const reason = `${channel}: rejected privileged IPC from an untrusted sender frame`;
      console.error(`[ipc] ${reason} (sender: ${senderUrl ?? '<none>'})`);
      throw new Error(reason);
    }
    try {
      return await handler(args, event);
    } catch (err) {
      const msg = toScrubbedMessage(err);
      // fs-safe and other low-level invariants already namespace with
      // `marudesk:`; only add the channel prefix when the message is bare.
      throw new Error(msg.startsWith('marudesk:') ? msg : `${channel}: ${msg}`, {
        cause: err,
      });
    }
  });
}
