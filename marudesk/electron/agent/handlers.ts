import type { ContextSyncPayload, EditorMirror, ExplorerMirror } from '../../shared/context';
import { isProviderId } from '../../shared/providers';
import { defineHandler } from '../ipc/define-handler';
import { nonEmptyStr, obj } from '../ipc/validate';
import { updateContextCache } from './context-cache';
import { cancelBackgroundTask } from './background';
import { editPlanStep } from './plan';
import { parseAbort, parseApprove, parseEditPlanStep, parseRespond, parseSendInput } from './parse';
import { searchSessions } from './sessions-store';
import { containerForWorkspace } from './loop-state.ts';
import { builtinToolInfo } from './tools/registry';
import {
  abortTurn,
  acceptEdit,
  approveTool,
  closeThread,
  compactConversation,
  deleteSavedSession,
  listSavedSessions,
  listThreads,
  newThread,
  reset,
  respond,
  restoreTurnCheckpoint,
  restoreTurnPage,
  resumeSession,
  revertEdit,
  snapshot,
  startTurn,
  switchThread,
  testProviderConnection,
} from './loop';
import type { WorkspaceId } from '../../shared/workspace';

const MAX_MIRRORED_EDITORS = 40;
const MAX_EDITOR_CONTENT = 24_000;
const MAX_EXPANDED_DIRS = 500;

function workspaceIdOf(payload: unknown): WorkspaceId | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const value = (payload as Record<string, unknown>).workspaceId;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function uiWorkspaceFilterOf(payload: unknown): WorkspaceId | null {
  return workspaceIdOf(payload) ?? null;
}

/** Defensively coerce the renderer's context mirror into the cached shape. */
function parseContextSync(payload: unknown): ContextSyncPayload {
  const o = obj(payload);
  const editorsRaw = Array.isArray(o.editors) ? o.editors : [];
  const editors: EditorMirror[] = editorsRaw.slice(0, MAX_MIRRORED_EDITORS).flatMap((e) => {
    if (!e || typeof e !== 'object') return [];
    const r = e as Record<string, unknown>;
    if (typeof r.path !== 'string') return [];
    const content = typeof r.content === 'string' ? r.content : '';
    const clipped = content.length > MAX_EDITOR_CONTENT;
    return [
      {
        path: r.path,
        dirty: !!r.dirty,
        content: clipped ? content.slice(0, MAX_EDITOR_CONTENT) : content,
        truncated: clipped || !!r.truncated,
      },
    ];
  });
  const ex = (o.explorer && typeof o.explorer === 'object' ? o.explorer : {}) as Record<string, unknown>;
  const explorer: ExplorerMirror = {
    root: typeof ex.root === 'string' ? ex.root : null,
    expandedDirs: Array.isArray(ex.expandedDirs)
      ? ex.expandedDirs.filter((d): d is string => typeof d === 'string').slice(0, MAX_EXPANDED_DIRS)
      : [],
    selectedPath: typeof ex.selectedPath === 'string' ? ex.selectedPath : null,
    fileCount: typeof ex.fileCount === 'number' ? ex.fileCount : undefined,
  };
  return { editors, explorer };
}

/**
 * IPC surface for the agentic AI Chat. Like every other domain it validates the
 * untrusted renderer payload before touching the loop; the loop itself owns all
 * state and streams it back on the `agent:event` snapshot. The payload parsers
 * live in ./parse so the headless bridge server (electron/server) reuses the
 * exact same validation for its REST commands.
 */

export function registerAgentHandlers(): void {
  defineHandler('agent:send', ([payload]) => startTurn(parseSendInput(payload)));

  defineHandler('agent:abort', ([payload]) => abortTurn(parseAbort(payload).turnId));

  defineHandler('agent:respond', ([payload]) => {
    const { turnId, callId, answers } = parseRespond(payload);
    return respond(turnId, callId, answers);
  });

  // The desktop UI's approve path: it calls the loop DIRECTLY (never the bridge
  // dispatcher), so a gated approval made here at the desktop is always honored.
  // Remote (bridge) self-approval of gated tools is what L-1 refuses, and that is
  // enforced in electron/server/dispatch.ts — keep this path off the dispatcher.
  defineHandler('agent:approve-tool', ([payload]) => {
    const { turnId, callId, approved, always } = parseApprove(payload);
    return approveTool(turnId, callId, approved, always);
  });

  defineHandler('agent:accept-edit', ([payload]) =>
    acceptEdit(nonEmptyStr(obj(payload).editId, 'editId'), uiWorkspaceFilterOf(payload)),
  );

  defineHandler('agent:revert-edit', ([payload]) =>
    revertEdit(nonEmptyStr(obj(payload).editId, 'editId'), uiWorkspaceFilterOf(payload)),
  );

  defineHandler('agent:restore-turn-page', ([payload]) =>
    restoreTurnPage(nonEmptyStr(obj(payload).turnId, 'turnId')),
  );

  defineHandler('agent:restore-checkpoint', ([payload]) =>
    restoreTurnCheckpoint(nonEmptyStr(obj(payload).turnId, 'turnId')),
  );

  // Built-in tool catalog for the Settings tool-groups UI (§3.11). Read-only;
  // gating is applied via the existing agent.denyTools setting.
  defineHandler('agent:list-tools', () => builtinToolInfo());

  // Tray "cancel" on a running background agent (audit H6) — the user-facing
  // twin of the model's cancel_background_agent tool.
  defineHandler('agent:cancel-background', ([payload]) =>
    cancelBackgroundTask(nonEmptyStr(obj(payload).id, 'id')),
  );

  // Steerable plan (v6 §U5): the user toggles a step's status or removes it.
  // Shares parseEditPlanStep with the bridge path so IPC + relay validate alike.
  defineHandler('agent:edit-plan-step', ([payload]) => {
    const { id, ...op } = parseEditPlanStep(payload);
    return editPlanStep(id, op);
  });

  defineHandler('agent:snapshot', ([payload]) => snapshot(workspaceIdOf(payload)));

  defineHandler('agent:reset', ([payload]) => reset(containerForWorkspace(workspaceIdOf(payload))));

  defineHandler('agent:compact', ([payload]) => {
    const data = obj(payload ?? {});
    const focus = typeof data.focus === 'string' ? data.focus : undefined;
    return compactConversation(focus, containerForWorkspace(workspaceIdOf(payload)));
  });

  // Session history (v3 §5-C): list past conversations, resume one as the active
  // chat, or delete one. list/delete proxy sessions-store; resume swaps loop state.
  defineHandler('agent:list-sessions', ([payload]) => listSavedSessions(uiWorkspaceFilterOf(payload)));

  // Full-text search over saved sessions (title + transcript). An empty query
  // returns the recent list — the search field's resting state.
  defineHandler('agent:search-sessions', ([payload]) => {
    const data = obj(payload);
    return searchSessions(typeof data.query === 'string' ? data.query : '', uiWorkspaceFilterOf(payload));
  });

  defineHandler('agent:resume-session', ([payload]) =>
    resumeSession(
      nonEmptyStr(obj(payload).id, 'id'),
      containerForWorkspace(workspaceIdOf(payload)),
    ),
  );

  defineHandler('agent:delete-session', ([payload]) =>
    deleteSavedSession(
      nonEmptyStr(obj(payload).id, 'id'),
      containerForWorkspace(workspaceIdOf(payload)),
    ),
  );

  // Thread switching (Stage 12-B-2): hold several conversations and switch the
  // active one. new/switch/close return the refreshed thread list; switching also
  // emits the target thread's state so the chat re-renders. Switching is refused
  // mid-turn (loop.switchThread guards busy), so the list comes back unchanged.
  defineHandler('agent:list-threads', ([payload]) => listThreads(workspaceIdOf(payload)));
  defineHandler('agent:new-thread', ([payload]) => {
    const workspaceId = workspaceIdOf(payload);
    const id = newThread(workspaceId);
    switchThread(id, workspaceId);
    return listThreads(workspaceId);
  });
  defineHandler('agent:switch-thread', ([payload]) => {
    const workspaceId = workspaceIdOf(payload);
    switchThread(nonEmptyStr(obj(payload).id, 'id'), workspaceId);
    return listThreads(workspaceId);
  });
  defineHandler('agent:close-thread', ([payload]) => {
    const workspaceId = workspaceIdOf(payload);
    closeThread(nonEmptyStr(obj(payload).id, 'id'), workspaceId);
    return listThreads(workspaceId);
  });

  // Built-in context MCP mirror: cache the renderer's latest editor/explorer
  // snapshot so the read_editor / read_explorer tools can read it (main can't
  // observe unsaved buffers or the tree state directly).
  defineHandler('context:sync', ([payload]) => {
    updateContextCache(parseContextSync(payload));
  });

  // Settings "Test connection" — a minimal live request to verify a provider's
  // key/OAuth actually works (OAuth providers have no /models endpoint to probe).
  defineHandler('providers:test-connection', ([provider, model]) => {
    if (!isProviderId(provider)) throw new Error('invalid provider');
    return testProviderConnection(provider, typeof model === 'string' ? model : undefined);
  });
}
