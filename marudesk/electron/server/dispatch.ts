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

/** A dispatched command's outcome. `result` mirrors the matching REST response body. */
export type DispatchResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

/**
 * Validate `args` for `cmd` (with the shared parsers) and run the matching loop
 * function. Never throws on bad input — a validation error is returned as
 * `{ ok:false, error }`. A thrown error from the loop itself (e.g. startTurn
 * rejecting) is also captured so neither transport's handler has to.
 */
export async function dispatchAgentCommand(
  agent: AgentApi,
  cmd: RelayCommandName,
  args: unknown,
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
