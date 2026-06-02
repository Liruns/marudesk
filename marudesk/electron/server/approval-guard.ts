import { isGatedTool } from '../agent/mcp';
import { getSettingsSync } from '../settings';
import type { ApprovalGuard } from './dispatch';

/**
 * Build the L-1 self-approval guard for the bridge transports
 * (docs/t2-secure-pairing-design.md §8, docs/remote-mobile-bridge-design.md §10.1).
 * Both the M4 HTTP router (electron/server/router.ts) and the Model B relay-client
 * (electron/server/relay-client.ts) pass this to {@link dispatchAgentCommand}, so a
 * REMOTE peer can never self-approve a gated tool (eval_js / cookies / storage /
 * terminal) while the bridge is exposed — that confirmation stays pinned to the
 * desktop UI, which approves over IPC straight into the loop (never the dispatcher).
 *
 * `serverExposed` reads the live settings each command (the user may toggle the
 * server mid-session); it is true whenever ANY bridge transport is exposed — the
 * local server (`server.enabled`, which is also the prerequisite for a paired phone
 * over LAN/Tailscale) or the cloud relay (`server.cloudEnabled`). With both off the
 * dispatcher isn't reachable at all, so the guard is a no-op and the desktop-only
 * flow is unchanged.
 */
export function createApprovalGuard(): ApprovalGuard {
  return {
    serverExposed: () => {
      const s = getSettingsSync().server;
      return s.enabled || s.cloudEnabled;
    },
    isGated: isGatedTool,
  };
}
