import type { ContextSyncPayload, EditorMirror, ExplorerMirror } from '../../shared/context';
import { isProviderId } from '../../shared/providers';
import { defineHandler } from '../ipc/define-handler';
import { nonEmptyStr, obj } from '../ipc/validate';
import { updateContextCache } from './context-cache';
import { parseAbort, parseApprove, parseRespond, parseSendInput } from './parse';
import { searchSessions } from './sessions-store';
import {
  abortTurn,
  acceptEdit,
  approveTool,
  compactConversation,
  deleteSavedSession,
  listSavedSessions,
  reset,
  respond,
  resumeSession,
  revertEdit,
  snapshot,
  startTurn,
  testProviderConnection,
} from './loop';

const MAX_MIRRORED_EDITORS = 40;
const MAX_EDITOR_CONTENT = 24_000;
const MAX_EXPANDED_DIRS = 500;

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
    acceptEdit(nonEmptyStr(obj(payload).editId, 'editId')),
  );

  defineHandler('agent:revert-edit', ([payload]) =>
    revertEdit(nonEmptyStr(obj(payload).editId, 'editId')),
  );

  defineHandler('agent:snapshot', () => snapshot());

  defineHandler('agent:reset', () => reset());

  defineHandler('agent:compact', ([focus]) =>
    compactConversation(typeof focus === 'string' ? focus : undefined),
  );

  // Session history (v3 §5-C): list past conversations, resume one as the active
  // chat, or delete one. list/delete proxy sessions-store; resume swaps loop state.
  defineHandler('agent:list-sessions', () => listSavedSessions());

  // Full-text search over saved sessions (title + transcript). An empty query
  // returns the recent list — the search field's resting state.
  defineHandler('agent:search-sessions', ([payload]) => {
    const query = obj(payload).query;
    return searchSessions(typeof query === 'string' ? query : '');
  });

  defineHandler('agent:resume-session', ([payload]) =>
    resumeSession(nonEmptyStr(obj(payload).id, 'id')),
  );

  defineHandler('agent:delete-session', ([payload]) =>
    deleteSavedSession(nonEmptyStr(obj(payload).id, 'id')),
  );

  // Built-in context MCP mirror: cache the renderer's latest editor/explorer
  // snapshot so the read_editor / read_explorer tools can read it (main can't
  // observe unsaved buffers or the tree state directly).
  defineHandler('context:sync', ([payload]) => {
    updateContextCache(parseContextSync(payload));
  });

  // Settings "Test connection" — a minimal live request to verify a provider's
  // key/OAuth actually works (OAuth providers have no /models endpoint to probe).
  defineHandler('providers:test-connection', ([provider]) => {
    if (!isProviderId(provider)) throw new Error('invalid provider');
    return testProviderConnection(provider);
  });
}
