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
 * The agent loop's public surface as ONE injectable object, shared by every
 * bridge transport (the remote server, the loopback companion, the relay
 * client) so they can't drift on which loop functions back which verbs.
 *
 * `snapshot`/`reset` take the bridge's optional workspace scope: a thin client
 * that selected a PC workspace acts on that workspace's ACTIVE thread (the same
 * container the desktop UI drives), so phone and desktop literally share one
 * conversation. Omitted ⇒ the global thread, the pre-workspace behavior.
 *
 * `snapshot` is remote-projected (remote-state.ts): the heavy per-edit
 * before/after content becomes the bounded `editDiffs` view every bridge
 * transport publishes — the same projection the SSE/relay push paths apply.
 *
 * `revertEdit` routes by edit id across the scope's threads (the loop's own
 * staleness guard protects the disk); the phone's Revert button rides this.
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
