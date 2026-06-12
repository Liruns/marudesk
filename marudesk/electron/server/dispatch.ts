import type {
  AgentAnswers,
  AgentChatState,
  AgentEditActionResult,
  AgentPlanStepStatus,
  AgentSendInput,
  AgentSendResult,
} from '../../shared/agent';
import type { AgentApprovalMode, ReasoningEffort } from '../../shared/settings';
import type { RelayCommandName } from '../../shared/remote';
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
          const snapshot = agent.snapshot();
          const queued = snapshot.approvalQueue.find(
            (item) => item.turnId === turnId && item.callId === callId,
          );
          const pending = snapshot.pendingApproval;
          const toolName =
            queued?.name ??
            (pending?.turnId === turnId && pending.callId === callId ? pending.name : null);
          if (toolName && guard.isGated(toolName)) {
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
      case 'reset': {
        const { workspaceId } = parseWorkspaceScope(args);
        return { ok: true, result: { ok: agent.reset(workspaceId) } };
      }
      case 'snapshot': {
        const { workspaceId } = parseWorkspaceScope(args);
        return { ok: true, result: agent.snapshot(workspaceId) };
      }
      case 'edit-plan-step': {
        const { id, status, remove } = parseEditPlanStep(args);
        return { ok: true, result: { ok: agent.editPlanStep(id, { status, remove }) } };
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
        // Exhaustiveness guard: a new RelayCommandName must be handled here.
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
