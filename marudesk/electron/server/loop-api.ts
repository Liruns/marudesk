import {
  abortTurn,
  approveTool,
  editPlanStep,
  reset,
  respond,
  setApprovalMode,
  snapshot,
  startTurn,
} from '../agent/loop';
import type { AgentApi } from './dispatch';

/**
 * The agent loop's public surface as ONE injectable object, shared by every
 * bridge transport (the remote server, the loopback companion, the relay
 * client) so they can't drift on which loop functions back which verbs.
 */
export const LOOP_AGENT_API: AgentApi = {
  startTurn,
  abortTurn,
  respond,
  approveTool,
  snapshot,
  reset,
  editPlanStep,
  setApprovalMode,
};
