import type {
  AgentAnswers,
  AgentChatState,
  AgentSendInput,
  AgentSendResult,
} from '../../shared/agent';
import type { RelayCommandName } from '../../shared/remote';
import { parseAbort, parseApprove, parseRespond, parseSendInput } from '../agent/parse';

/**
 * The ONE place an untrusted agent command (from either transport) is validated
 * with the shared electron/agent/parse.ts parsers and dispatched to the loop's
 * public API. Both the M4 REST router (electron/server/router.ts) and the Bridge
 * Model B relay-client (electron/server/relay-client.ts) call this, so the two
 * entry points can never drift in validation or loop semantics — the whole point
 * of §3 "reuse the M4 command/snapshot shape" (docs/bridge-model-b-design.md).
 *
 * It is pure aside from the injected {@link AgentApi}: the command verbs map 1:1
 * onto the loop functions, the args are the same shapes the matching `/agent/*`
 * endpoint expects, and a parser/dispatch failure comes back as `{ ok:false, error }`
 * rather than throwing — so a relay peer's bad input is a tidy ack, not a crash.
 */

/** The agent loop's public surface, injected so this stays unit-testable (no Electron). */
export type AgentApi = {
  startTurn(input: AgentSendInput): Promise<AgentSendResult>;
  abortTurn(turnId: string): boolean;
  respond(turnId: string, callId: string, answers: AgentAnswers): boolean;
  approveTool(turnId: string, callId: string, approved: boolean): boolean;
  snapshot(): AgentChatState;
  reset(): boolean;
};

/**
 * Environment facts the L-1 self-approval guard needs (docs/t2-secure-pairing-design.md
 * §8). Injected so this dispatcher stays pure — Electron-free and headlessly
 * testable. `serverExposed` is read live per command (the user may toggle the
 * server mid-session); `isGated` classifies the tool currently parked for approval.
 * Built in production by {@link createApprovalGuard} (electron/server/approval-guard.ts).
 */
export type ApprovalGuard = {
  /** True while a bridge transport is exposed (local server and/or cloud relay). */
  serverExposed(): boolean;
  /** True if `toolName` requires explicit per-call approval (eval_js, cookies, …). */
  isGated(toolName: string): boolean;
};

/** A dispatched command's outcome. `result` mirrors the matching REST response body. */
export type DispatchResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

/**
 * Validate `args` for `cmd` (with the shared parsers) and run the matching loop
 * function. Never throws on bad input — a validation error is returned as
 * `{ ok:false, error }`. A thrown error from the loop itself (e.g. startTurn
 * rejecting) is also captured so neither transport's handler has to.
 *
 * Because EVERY command here is bridge-originated (the desktop IPC path calls the
 * loop directly, never this dispatcher), the optional `guard` enforces L-1: while
 * the bridge is exposed, a remote peer cannot self-approve a gated tool — that
 * stays pinned to the desktop UI (docs/t2-secure-pairing-design.md §8).
 */
export async function dispatchAgentCommand(
  agent: AgentApi,
  cmd: RelayCommandName,
  args: unknown,
  guard?: ApprovalGuard,
): Promise<DispatchResult> {
  try {
    switch (cmd) {
      case 'send': {
        const input = parseSendInput(args);
        return { ok: true, result: await agent.startTurn(input) };
      }
      case 'abort': {
        const { turnId } = parseAbort(args);
        return { ok: true, result: { ok: agent.abortTurn(turnId) } };
      }
      case 'respond': {
        const { turnId, callId, answers } = parseRespond(args);
        return { ok: true, result: { ok: agent.respond(turnId, callId, answers) } };
      }
      case 'approve': {
        const { turnId, callId, approved } = parseApprove(args);
        // L-1: a remote (bridge) peer must not SELF-APPROVE a gated tool while the
        // bridge is exposed — that confirmation is pinned to the desktop UI. A
        // remote DENY (approved=false) is always honored (fail-safe: a phone can
        // still cancel a dangerous tool); only a remote APPROVE is refused, and
        // only for the gated tool actually parked for THIS turn/call.
        if (approved && guard?.serverExposed()) {
          const pending = agent.snapshot().pendingApproval;
          if (
            pending &&
            pending.turnId === turnId &&
            pending.callId === callId &&
            guard.isGated(pending.name)
          ) {
            return {
              ok: false,
              error:
                'This tool must be approved on the desktop while the remote bridge is on. ' +
                'Gated tools (code execution, cookies, storage, terminal) cannot be approved remotely.',
            };
          }
        }
        return { ok: true, result: { ok: agent.approveTool(turnId, callId, approved) } };
      }
      case 'reset':
        return { ok: true, result: { ok: agent.reset() } };
      case 'snapshot':
        return { ok: true, result: agent.snapshot() };
      default: {
        // Exhaustiveness guard: a new RelayCommandName must be handled here.
        const _never: never = cmd;
        return { ok: false, error: `unknown command: ${String(_never)}` };
      }
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
