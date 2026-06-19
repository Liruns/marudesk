import type {
  AgentAnswers,
  AgentChatState,
  AgentEditActionResult,
  AgentPlanStepStatus,
  AgentSendInput,
  AgentSendResult,
} from '../../shared/agent';
import type { AgentApprovalMode, ReasoningEffort } from '../../shared/settings';
import type { AgentCommandName } from '../../shared/remote';
import {
  parseAbort,
  parseApprove,
  parseEditPlanStep,
  parseRespond,
  parseRevertEdit,
  parseSendInput,
  parseSetApprovalMode,
  parseSetReasoningEffort,
  parseWorkspaceScope,
} from '../agent/parse';

/**
 * The ONE place an untrusted agent command (from the loopback CLI bridge) is
 * validated with the shared electron/agent/parse.ts parsers and dispatched to the
 * loop's public API. The router (electron/cli-bridge/router.ts) is its only caller,
 * so the REST surface and the loop semantics can never drift.
 *
 * It is pure aside from the injected {@link AgentApi}: the command verbs map 1:1
 * onto the loop functions, the args are the same shapes the matching `/agent/*`
 * endpoint expects, and a parser/dispatch failure comes back as `{ ok:false, error }`
 * rather than throwing — so bad input is a tidy ack, not a crash.
 */

/** The agent loop's public surface, injected so this stays unit-testable (no Electron). */
export type AgentApi = {
  startTurn(input: AgentSendInput): Promise<AgentSendResult>;
  abortTurn(turnId: string): boolean;
  respond(turnId: string, callId: string, answers: AgentAnswers): boolean;
  approveTool(turnId: string, callId: string, approved: boolean): boolean;
  /** `workspaceId` scopes to that workspace's active thread; omitted ⇒ the global thread. */
  snapshot(workspaceId?: string): AgentChatState;
  /** `workspaceId` scopes to that workspace's active thread; omitted ⇒ the global thread. */
  reset(workspaceId?: string): boolean;
  /** U5 mobile parity: cycle a plan step's status or remove it. */
  editPlanStep(id: string, op: { status?: AgentPlanStepStatus; remove?: boolean }): boolean;
  /** U10 mobile parity: set + persist the approval mode (applies next turn). */
  setApprovalMode(mode: AgentApprovalMode): boolean;
  /** Mobile parity for the desktop reasoning dial: set + persist (applies next turn). */
  setReasoningEffort(effort: ReasoningEffort): boolean;
  /**
   * Mobile parity for the desktop Changes card's per-edit Revert: restore an
   * APPLIED edit's pre-edit content on disk (PC-owned logic; the loop's own
   * staleness guard refuses if the file changed since). `workspaceId` scopes the
   * lookup to that workspace's threads; omitted ⇒ any thread (edit ids are
   * unique). OPTIONAL so harness mocks / older embedders that predate the verb
   * keep compiling — the dispatcher answers `{ ok:false }` when absent.
   */
  revertEdit?(editId: string, workspaceId?: string): Promise<AgentEditActionResult>;
};

/** A dispatched command's outcome. `result` mirrors the matching REST response body. */
export type DispatchResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

/**
 * Validate `args` for `cmd` (with the shared parsers) and run the matching loop
 * function. Never throws on bad input — a validation error is returned as
 * `{ ok:false, error }`. A thrown error from the loop itself (e.g. startTurn
 * rejecting) is also captured so the caller doesn't have to.
 */
export async function dispatchAgentCommand(
  agent: AgentApi,
  cmd: AgentCommandName,
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
      case 'reset': {
        const { workspaceId } = parseWorkspaceScope(args);
        return { ok: true, result: { ok: agent.reset(workspaceId) } };
      }
      case 'snapshot': {
        const { workspaceId } = parseWorkspaceScope(args);
        return { ok: true, result: agent.snapshot(workspaceId) };
      }
      case 'edit-plan-step': {
        const { id, ...op } = parseEditPlanStep(args);
        return { ok: true, result: { ok: agent.editPlanStep(id, op) } };
      }
      case 'set-approval-mode': {
        const { mode } = parseSetApprovalMode(args);
        return { ok: true, result: { ok: agent.setApprovalMode(mode) } };
      }
      case 'set-reasoning-effort': {
        const { effort } = parseSetReasoningEffort(args);
        return { ok: true, result: { ok: agent.setReasoningEffort(effort) } };
      }
      case 'revert-edit': {
        const { editId, workspaceId } = parseRevertEdit(args);
        if (!agent.revertEdit) {
          return { ok: false, error: 'this host does not support remote revert' };
        }
        // A refused revert (stale file, already resolved, …) surfaces as a tidy
        // error so the phone shows WHY nothing changed instead of a silent no-op;
        // the loop already emitted no state change in that case.
        const res = await agent.revertEdit(editId, workspaceId);
        if (!res.ok) return { ok: false, error: revertFailureMessage(res.reason) };
        return { ok: true, result: res };
      }
      default: {
        // Exhaustiveness guard: a new AgentCommandName must be handled here.
        const _never: never = cmd;
        return { ok: false, error: `unknown command: ${String(_never)}` };
      }
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Human-readable message per {@link AgentEditActionResult} refusal reason. */
function revertFailureMessage(reason: AgentEditActionResult['reason']): string {
  switch (reason) {
    case 'stale':
      return 'The file changed since this edit — revert it from the desktop to resolve.';
    case 'not-found':
      return 'This edit is no longer revertible (already kept or reverted).';
    case 'no-workspace':
      return 'No workspace is open on the PC for this edit.';
    case 'write-failed':
      return 'The PC could not write the file.';
    default:
      return 'Revert failed.';
  }
}
