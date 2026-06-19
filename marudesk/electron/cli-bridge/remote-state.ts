import type { AgentChatState, AgentEdit } from '../../shared/agent';
import {
  REMOTE_EDIT_DIFF_MAX_CHARS,
  REMOTE_EDIT_DIFF_MAX_ENTRIES,
  type RemoteAgentState,
  type RemoteEditDiff,
} from '../../shared/remote';
import { buildUnifiedDiff, clipDiffText } from '../../shared/edit-diff';

/**
 * The ONE projection the CLI bridge applies to a snapshot before it leaves the
 * PC: the loopback companion's REST/SSE router publishes through this (see
 * loop-api.ts + the router's `subscribe` wiring). It follows the loop's existing
 * emit-boundary pattern (approvalMode/reasoningEffort are stamped the same way
 * in loop-state.ts): derive what a thin terminal client needs, never mutate the
 * authoritative state.
 *
 * What it does:
 *  - stamps `editDiffs`: per applied/kept/reverted edit, a BOUNDED unified diff
 *    (clipped at {@link REMOTE_EDIT_DIFF_MAX_CHARS}) + the ids/status a client
 *    needs to render a review row and act (`revert-edit`);
 *  - empties the heavy `edits` array (full before/after file contents) so one
 *    big file edit can't balloon every SSE frame — no bridge client reads it
 *    (the desktop renderer rides IPC, not this projection).
 *
 * Both changes are wire-backward-compatible: `editDiffs` is optional (older
 * clients ignore it) and `edits` keeps its shape (just empty).
 */

/**
 * Diff cache keyed by edit id: an AgentEdit's before/after are immutable for a
 * given id (only `status` flips), and the loop re-emits the full state on every
 * streaming tick — so without this, a long turn would re-diff every edit dozens
 * of times. Cleared wholesale past the cap (diffs are cheap to recompute).
 */
type CachedDiff = { diff: string; additions: number; deletions: number; truncated: boolean };
const diffCache = new Map<string, CachedDiff>();
const DIFF_CACHE_MAX = 512;

function diffOf(edit: AgentEdit): CachedDiff {
  const hit = diffCache.get(edit.id);
  if (hit) return hit;
  const { diff, additions, deletions } = buildUnifiedDiff(edit.before, edit.after);
  const clipped = clipDiffText(diff, REMOTE_EDIT_DIFF_MAX_CHARS);
  const entry: CachedDiff = {
    diff: clipped.text,
    additions,
    deletions,
    truncated: clipped.truncated,
  };
  if (diffCache.size >= DIFF_CACHE_MAX) diffCache.clear();
  diffCache.set(edit.id, entry);
  return entry;
}

function toRemoteEditDiff(edit: AgentEdit): RemoteEditDiff {
  const d = diffOf(edit);
  return {
    id: edit.id,
    turnId: edit.turnId,
    // The edit path is workspace-root-relative — the same root-qualified label
    // the desktop Changes card shows.
    label: edit.path,
    kind: edit.kind,
    status: edit.status,
    diff: d.diff,
    additions: d.additions,
    deletions: d.deletions,
    truncated: d.truncated,
    timestamp: edit.timestamp,
  };
}

/** Project one authoritative snapshot into the bounded remote shape (pure). */
export function projectRemoteState(state: AgentChatState): RemoteAgentState {
  if (state.edits.length === 0) return state;
  // Newest-last cap: a marathon conversation's review tail, not its full history.
  const edits = state.edits.slice(-REMOTE_EDIT_DIFF_MAX_ENTRIES);
  return { ...state, edits: [], editDiffs: edits.map(toRemoteEditDiff) };
}

/** Wrap a state-stream subscriber so every push is remote-projected. */
export function projectRemoteCallback(
  cb: (state: AgentChatState) => void,
): (state: AgentChatState) => void {
  return (state) => cb(projectRemoteState(state));
}
