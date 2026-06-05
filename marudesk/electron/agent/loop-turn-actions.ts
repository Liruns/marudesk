import fs from 'node:fs/promises';
import type {
  AgentAnswers,
  AgentChatState,
  AgentEdit,
} from '../../shared/agent';
import type { WorkspaceSummary } from '../../shared/workspace';
import { requireWorkspace } from '../ipc/define-handler';
import { isInsideRoot, resolveWorkspacePath } from '../fs-safe';
import { writeFileForEditor } from '../workspace';
import { S, emit } from './loop-state.ts';

/**
 * Turn-control public API (handlers.ts surface): abort the running turn, answer
 * an ask_user / approve a gated tool (settling the parked resolver), and
 * accept/revert an applied edit. Operate on the shared {@link S} container;
 * extracted from loop.ts.
 */

export function abortTurn(turnId: string): boolean {
  if (S.state.turnId !== turnId || !S.controller) return false;
  S.controller.abort();
  // Unblock a parked turn so the loop can observe the abort and bail cleanly.
  S.approvalResolver?.({ approved: false, always: false });
  S.answersResolver?.({});
  return true;
}

export function respond(turnId: string, callId: string, answers: AgentAnswers): boolean {
  if (S.state.pendingQuestions?.turnId !== turnId || S.state.pendingQuestions?.callId !== callId) return false;
  if (!S.answersResolver) return false;
  S.answersResolver(answers ?? {});
  return true;
}

export function approveTool(
  turnId: string,
  callId: string,
  approved: boolean,
  always = false,
): boolean {
  if (S.state.pendingApproval?.turnId !== turnId || S.state.pendingApproval?.callId !== callId) return false;
  if (!S.approvalResolver) return false;
  S.approvalResolver({ approved, always });
  return true;
}

export function acceptEdit(editId: string): boolean {
  const edit = S.state.edits.find((e) => e.id === editId);
  if (!edit || edit.status !== 'applied') return false;
  edit.status = 'accepted';
  emit();
  return true;
}

export async function revertEdit(editId: string): Promise<boolean> {
  const edit = S.state.edits.find((e) => e.id === editId);
  if (!edit || edit.status !== 'applied') return false;
  let ws: WorkspaceSummary;
  try {
    ws = requireWorkspace().ws;
  } catch {
    return false;
  }
  try {
    await revertOnDisk(ws, edit);
  } catch {
    return false;
  }
  edit.status = 'reverted';
  emit();
  return true;
}

async function revertOnDisk(ws: WorkspaceSummary, edit: AgentEdit): Promise<void> {
  if (edit.kind === 'edit' && edit.before !== null) {
    await writeFileForEditor(ws.root, edit.path, edit.before);
    return;
  }
  if (edit.kind === 'create') {
    const { abs } = resolveWorkspacePath(ws.root, edit.path);
    const lst = await fs.lstat(abs).catch(() => null);
    if (lst && !lst.isSymbolicLink() && lst.isFile()) {
      const real = await fs.realpath(abs);
      if (isInsideRoot(ws.root, real)) await fs.unlink(abs);
    }
  }
}

export function snapshot(): AgentChatState {
  return S.state;
}
