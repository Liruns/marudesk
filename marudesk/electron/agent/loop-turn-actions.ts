import fs from 'node:fs/promises';
import type {
  AgentAnswers,
  AgentChatState,
  AgentEdit,
  AgentEditActionResult,
} from '../../shared/agent';
import type { WorkspaceSummary } from '../../shared/workspace';
import type { AgentApprovalMode } from '../../shared/settings';
import { requireWorkspace } from '../ipc/define-handler';
import { isInsideRoot, resolveWorkspacePath } from '../fs-safe';
import { readFileSafe, writeFileForEditor } from '../workspace';
import { MAX_AGENT_FILE_SIZE } from '../workspace-config';
import { patchSettings } from '../settings';
import { effectiveAgentRoot } from '../worktree-isolation';
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

export function acceptEdit(editId: string): AgentEditActionResult {
  const edit = S.state.edits.find((e) => e.id === editId);
  if (!edit || edit.status !== 'applied') return { ok: false, reason: 'not-found' };
  edit.status = 'accepted';
  emit();
  return { ok: true };
}

export async function revertEdit(editId: string): Promise<AgentEditActionResult> {
  const edit = S.state.edits.find((e) => e.id === editId);
  if (!edit || edit.status !== 'applied') return { ok: false, reason: 'not-found' };
  let ws: WorkspaceSummary;
  try {
    ws = requireWorkspace().ws;
    // Mirror the loop's worktree-isolation routing: when active, the agent wrote
    // this edit in the worktree, so revert must restore it there (not in main).
    const eff = effectiveAgentRoot(ws.root);
    if (eff !== ws.root) ws = { ...ws, root: eff };
  } catch {
    return { ok: false, reason: 'no-workspace' };
  }
  // Staleness guard — the symmetric twin of the forward edit path's
  // isStaleForEdit. Only revert when the file on disk still holds exactly what
  // this edit wrote (`edit.after`). If it changed since (the user saved, a later
  // turn edited it, the terminal rewrote it), restoring `before` would silently
  // clobber that newer content, so refuse and let the user resolve it instead.
  if (!(await isRevertSafe(ws, edit))) return { ok: false, reason: 'stale' };
  try {
    await revertOnDisk(ws, edit);
  } catch {
    return { ok: false, reason: 'write-failed' };
  }
  edit.status = 'reverted';
  emit();
  return { ok: true };
}

/**
 * Whether `edit` can be reverted without losing post-edit changes: the file on
 * disk must still match exactly what the edit produced. A create whose file is
 * already gone counts as safe (nothing to clobber); an edit whose file we can't
 * read counts as unsafe (we can't prove it's unchanged).
 */
async function isRevertSafe(ws: WorkspaceSummary, edit: AgentEdit): Promise<boolean> {
  let current: string;
  try {
    current = await readFileSafe(ws.root, edit.path, MAX_AGENT_FILE_SIZE);
  } catch {
    return edit.kind === 'create';
  }
  return current === edit.after;
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

const APPROVAL_MODES: readonly AgentApprovalMode[] = ['read-only', 'ask', 'auto', 'plan'];

/**
 * Set the agent approval mode and persist it (U10 mobile parity). Mirrors the
 * desktop composer toggle, which patches `agent.approvalMode` in settings; the
 * loop reads `getSettingsSync().agent.approvalMode` at the start of each turn, so
 * a change applies to the NEXT turn (not a mid-turn one). Exposed on the bridge
 * AgentApi so a paired phone can flip it remotely; an unknown mode is a no-op
 * `false`. The patch is serialized through the same writer as the IPC path.
 */
export function setApprovalMode(mode: AgentApprovalMode): boolean {
  if (!APPROVAL_MODES.includes(mode)) return false;
  void patchSettings({ agent: { approvalMode: mode } });
  return true;
}
