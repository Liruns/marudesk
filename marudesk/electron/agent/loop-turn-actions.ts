import fs from 'node:fs/promises';
import type {
  AgentAnswers,
  AgentChatState,
  AgentEdit,
  AgentEditActionResult,
} from '../../shared/agent';
import type { WorkspaceSummary } from '../../shared/workspace';
import type { AgentApprovalMode, ReasoningEffort } from '../../shared/settings';
import { requireWorkspace } from '../ipc/define-handler';
import { isInsideRoot, resolveWorkspacePath } from '../fs-safe';
import { readFileSafe, writeFileForEditor } from '../workspace';
import { MAX_AGENT_FILE_SIZE } from '../workspace-config';
import { getSettingsSync, patchSettings } from '../settings';
import type { CheckpointRestore } from '../../shared/worktree';
import { effectiveAgentRoot } from '../worktree-isolation';
import { createCheckpoint, restoreCheckpoint } from '../git-worktree';
import { getActive, getTab } from '../browser/state';
import { navigateActive } from '../browser/navigation';
import { getWorkspaceSummary } from '../workspace-registry';
import {
  emitContainer,
  containers,
  containerForTurn,
  containerForWorkspace,
  refreshOrchestrationProjection,
  type ThreadContainer,
} from './loop-state.ts';
import type { WorkspaceId } from '../../shared/workspace';

/**
 * Turn-control public API (handlers.ts surface): abort the running turn, answer
 * an ask_user / approve a gated tool (settling the parked resolver), and
 * accept/revert an applied edit. Turn-control actions route by turnId across ALL
 * threads (Stage 12-B-2 concurrent execution) — the parked turn may live in a
 * non-active thread if the user switched away — while accept/revert act on the
 * active thread's edits (the chat the user is looking at).
 */

export function abortTurn(turnId: string): boolean {
  const c = containerForTurn(turnId);
  if (!c || !c.controller) return false;
  c.controller.abort();
  // Unblock a parked turn so the loop can observe the abort and bail cleanly.
  c.approvalResolver?.({ approved: false, always: false });
  c.answersResolver?.({});
  return true;
}

export function respond(turnId: string, callId: string, answers: AgentAnswers): boolean {
  const c = containerForTurn(turnId);
  if (!c || c.state.pendingQuestions?.turnId !== turnId || c.state.pendingQuestions?.callId !== callId) return false;
  if (!c.answersResolver) return false;
  c.answersResolver(answers ?? {});
  return true;
}

export function approveTool(
  turnId: string,
  callId: string,
  approved: boolean,
  always = false,
): boolean {
  const c = containerForTurn(turnId);
  if (!c || c.state.pendingApproval?.turnId !== turnId || c.state.pendingApproval?.callId !== callId) return false;
  if (!c.approvalResolver) return false;
  c.approvalResolver({ approved, always });
  return true;
}

type WorkspaceFilter = WorkspaceId | null | undefined;

function matchesWorkspace(container: ThreadContainer, workspaceId: WorkspaceFilter): boolean {
  if (workspaceId === undefined) return true;
  return (container.workspaceId ?? null) === workspaceId;
}

function containerForEdit(editId: string, workspaceId: WorkspaceFilter): ThreadContainer | null {
  return (
    containers().find(
      (container) =>
        matchesWorkspace(container, workspaceId) &&
        container.state.edits.some((e) => e.id === editId),
    ) ?? null
  );
}

export function acceptEdit(editId: string, workspaceId?: WorkspaceFilter): AgentEditActionResult {
  const container = containerForEdit(editId, workspaceId);
  if (!container) return { ok: false, reason: 'not-found' };
  const edit = container.state.edits.find((e) => e.id === editId);
  if (!edit || edit.status !== 'applied') return { ok: false, reason: 'not-found' };
  edit.status = 'accepted';
  emitContainer(container);
  return { ok: true };
}

export async function revertEdit(
  editId: string,
  workspaceId?: WorkspaceFilter,
): Promise<AgentEditActionResult> {
  const container = containerForEdit(editId, workspaceId);
  if (!container) return { ok: false, reason: 'not-found' };
  const edit = container.state.edits.find((e) => e.id === editId);
  if (!edit || edit.status !== 'applied') return { ok: false, reason: 'not-found' };
  let ws: WorkspaceSummary;
  try {
    const scoped = container.workspaceId ? getWorkspaceSummary(container.workspaceId) : null;
    ws = scoped ?? requireWorkspace().ws;
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
  emitContainer(container);
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

export function snapshot(workspaceId?: WorkspaceId): AgentChatState {
  // The projection (approvalQueue/orchestration) is normally refreshed inside the
  // coalesced emit flushes; refresh here so a synchronous reader — the renderer's
  // initial pull, the bridge's L-1 gated-tool guard — never sees a stale queue.
  refreshOrchestrationProjection();
  const state = containerForWorkspace(workspaceId).state;
  // Stamp the settings projections too: a workspace container that hasn't emitted
  // yet (a thin client's first pull) would otherwise show the empty-state defaults.
  const agent = getSettingsSync().agent;
  state.approvalMode = agent.approvalMode;
  state.reasoningEffort = agent.reasoningEffort;
  return state;
}

/**
 * Runtime marker for turn-level rollback: the live web tab's URL at the moment a
 * turn started, keyed by turnId. Module-scoped (session-lived, not persisted) so
 * it never bloats the snapshot or the bridge. Recorded by the loop at turn start.
 */
const turnStartUrl = new Map<string, string>();

export function recordTurnStartUrl(turnId: string, tabId: string | undefined): void {
  if (!tabId) return;
  const url = getTab(tabId)?.view?.webContents.getURL();
  if (url) turnStartUrl.set(turnId, url);
}

/**
 * Re-navigate the active web tab back to where it was when `turnId` started —
 * the runtime half of a turn-level "restore" (the edit half is the existing
 * Revert all). No-op unless the agent actually moved the page during the turn, so
 * a plain code revert doesn't surprise the user by navigating.
 */
export async function restoreTurnPage(turnId: string): Promise<{ navigated: boolean }> {
  const url = turnStartUrl.get(turnId);
  if (!url) return { navigated: false };
  const current = getActive()?.view?.webContents.getURL();
  if (!current || current === url) return { navigated: false };
  try {
    await navigateActive(url);
    return { navigated: true };
  } catch {
    return { navigated: false };
  }
}

/**
 * Turn checkpoint (§3.6): a non-destructive snapshot of the agent's working tree
 * at turn start, keyed by turnId. Module-scoped (session-lived) like the URL
 * marker. Unlike the edits list, this also captures changes the agent made via
 * the terminal, so restore can roll the WHOLE tree back to the turn's start.
 */
const turnCheckpoint = new Map<string, { root: string; sha: string | null }>();

/**
 * Drop the per-turn runtime markers (start URL + checkpoint snapshot). Called by
 * reset() on a new chat so these session-lived maps don't grow unbounded across
 * conversations. Turn ids are unique, so this only reclaims memory — the live
 * chat's edits keep their own per-edit revert.
 */
export function clearTurnRuntimeState(): void {
  turnStartUrl.clear();
  turnCheckpoint.clear();
}

/** `root` is the agent's effective working root (the worktree when isolated). */
export async function recordTurnCheckpoint(turnId: string, root: string): Promise<void> {
  const sha = await createCheckpoint(root);
  turnCheckpoint.set(turnId, { root, sha });
}

/**
 * Roll the working tree back to a turn's checkpoint. Safe by construction —
 * current work is parked on the stash stack before the snapshot is re-applied
 * (see restoreCheckpoint), so nothing is ever destroyed.
 */
export async function restoreTurnCheckpoint(turnId: string): Promise<CheckpointRestore> {
  const cp = turnCheckpoint.get(turnId);
  if (!cp) return { ok: false, reason: 'none' };
  return restoreCheckpoint(cp.root, cp.sha);
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

const REASONING_EFFORTS: readonly ReasoningEffort[] = ['minimal', 'low', 'medium', 'high'];

/**
 * Set the reasoning effort and persist it — the mobile twin of the desktop
 * composer's reasoning dial, with exactly {@link setApprovalMode}'s semantics:
 * the loop reads `getSettingsSync().agent.reasoningEffort` at turn start, so a
 * change applies to the NEXT turn. An unknown effort is a no-op `false`.
 */
export function setReasoningEffort(effort: ReasoningEffort): boolean {
  if (!REASONING_EFFORTS.includes(effort)) return false;
  void patchSettings({ agent: { reasoningEffort: effort } });
  return true;
}
