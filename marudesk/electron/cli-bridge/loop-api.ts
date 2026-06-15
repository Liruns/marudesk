import {
  abortTurn,
  approveTool,
  editPlanStep,
  reset,
  respond,
  revertEdit,
  setApprovalMode,
  setReasoningEffort,
  snapshot,
  startTurn,
} from '../agent/loop';
import { containerForWorkspace } from '../agent/loop-state.ts';
import type { AgentApi } from './dispatch';
import { projectRemoteState } from './remote-state';

/**
 * The agent loop's public surface as ONE injectable object (the `AgentApi`
 * seam): the CLI bridge's REST/SSE router calls these verbs, and tests inject a
 * mock in their place, so neither can drift on which loop functions back which
 * verbs.
 *
 * `snapshot`/`reset` take an optional workspace scope: a CLI client that
 * selected a PC workspace acts on that workspace's ACTIVE thread (the same
 * container the desktop UI drives), so the terminal and desktop share one
 * conversation. Omitted ⇒ the global thread, the pre-workspace behavior.
 *
 * `snapshot` is remote-projected (remote-state.ts): the heavy per-edit
 * before/after content becomes the bounded `editDiffs` view the router
 * publishes — the same projection the SSE push path applies.
 *
 * `revertEdit` routes by edit id across the scope's threads (the loop's own
 * staleness guard protects the disk); the CLI's Revert action rides this.
 */
export const LOOP_AGENT_API: AgentApi = {
  startTurn,
  abortTurn,
  respond,
  approveTool,
  snapshot: (workspaceId) => projectRemoteState(snapshot(workspaceId)),
  reset: (workspaceId) => reset(containerForWorkspace(workspaceId)),
  editPlanStep,
  setApprovalMode,
  setReasoningEffort,
  revertEdit: (editId, workspaceId) => revertEdit(editId, workspaceId),
};
