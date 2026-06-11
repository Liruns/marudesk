import path from 'node:path';
import { app } from 'electron';
import { toMessage } from '../../shared/to-message';
import { subscribeAgentEvents, subscribeWorkspaceAgentEvents } from '../agent/loop';
import { startCompanionServer, type CompanionHandle } from './companion-core';
import { createRouterExtras } from './extras';
import { LOOP_AGENT_API } from './loop-api';
import { getServerToken } from './token';

/**
 * Electron-bound lifecycle for the loopback companion listener
 * (companion-core.ts; chat CLI v2 — docs/chat-cli-tui-design.md §3). Started at
 * app boot, stopped at quit; always on (Chrome `DevToolsActivePort` precedent).
 * Owns `cli-bridge.json` in userData — the remote bridge server no longer
 * writes it, so `npm run chat` works whenever the app runs, Remote on or off.
 */

let handle: CompanionHandle | null = null;
let token: string | null = null;
/** Guards overlapping start/stop while the async start is in flight. */
let transitioning: Promise<void> | null = null;

/**
 * Connection info for the embedded CLI terminal profile (electron/terminal.ts
 * injects it as MARUDESK_BRIDGE_URL/TOKEN), or null while not listening.
 * Never reaches the renderer.
 */
export function getCompanionConnection(): { url: string; token: string } | null {
  if (!handle || !token) return null;
  return { url: handle.url, token };
}

/** Start the companion listener (idempotent; a bind failure logs and degrades). */
export function startCompanion(): Promise<void> {
  if (transitioning) return transitioning;
  transitioning = (async () => {
    if (handle) return;
    try {
      const bearer = await getServerToken();
      const started = await startCompanionServer({
        handshakeFile: path.join(app.getPath('userData'), 'cli-bridge.json'),
        deps: {
          token: bearer,
          version: app.getVersion(),
          agent: LOOP_AGENT_API,
          subscribe: subscribeAgentEvents,
          subscribeWorkspace: (workspaceId, cb) =>
            subscribeWorkspaceAgentEvents((wsId, state) => {
              if (wsId === workspaceId) cb(state);
            }),
          extras: createRouterExtras(),
          // Deliberately NO devices/pair (loopback has no E2E path) and NO
          // approvalGuard — same-user loopback IS the desktop user (§3).
        },
      });
      handle = started;
      token = bearer;
      console.log(`[companion] CLI bridge listening on ${started.url}`);
    } catch (err) {
      // Never fatal: the desktop app works without the CLI surface; the CLI
      // reports "no bridge connection" when the handshake file is absent.
      console.error('[companion] failed to start:', toMessage(err));
    }
  })().finally(() => {
    transitioning = null;
  });
  return transitioning;
}

/** Stop the companion listener and remove the handshake file. */
export async function stopCompanion(): Promise<void> {
  if (transitioning) await transitioning;
  const current = handle;
  handle = null;
  token = null;
  if (current) await current.close();
}
