import {
  emptyAgentChatState,
  type AgentMessage,
} from '../../shared/agent';
import type { SessionRecord, SessionSummary } from '../../shared/context';
import { getSettingsSync } from '../settings';
import { clearReadTracker } from './read-tracker';
import { clearNestedInstructionClaims } from './nested-instructions';
import { clearTurnRuntimeState } from './loop-turn-actions.ts';
import {
  deleteSession,
  listSessions,
  readSession,
  saveSession,
  type SessionWorkspaceFilter,
} from './sessions-store';
import {
  containerBusy,
  emitContainer,
  currentContainer as activeContainer,
  type ThreadContainer,
} from './loop-state.ts';
import { cancelBackgroundForConversation } from './background.ts';

/**
 * Session persistence + lifecycle for the agent loop: snapshot/persist the live
 * conversation to sessions-store, and the reset / resume / list / delete actions
 * (handlers.ts surface). Operate on the shared {@link S} container so they can
 * reassign loop state by reference. Extracted from loop.ts.
 */

/** Clip a tool result before persisting so a session file can't grow unbounded. */
function snapshotMessagesForSave(S: ThreadContainer): AgentMessage[] {
  return S.state.messages.map((m) => ({
    ...m,
    parts: m.parts.map((p) => {
      if (p.type !== 'tool') return p;
      const rt = p.call.resultText;
      return rt && rt.length > 4_000
        ? { ...p, call: { ...p.call, resultText: `${rt.slice(0, 4_000)}…` } }
        : p;
    }),
  }));
}

export async function persistSession(S: ThreadContainer = activeContainer()): Promise<void> {
  if (!S.conversationId) return;
  // Respect the Data & Storage toggle: when session saving is off, conversations
  // stay in-memory only (no S.transcript written, nothing added to history).
  if (!getSettingsSync().storage.persistSessions) return;
  const record: SessionRecord = {
    id: S.conversationId,
    ...(S.workspaceId ? { workspaceId: S.workspaceId } : {}),
    title: S.conversationTitle || 'Untitled chat',
    createdAt: S.conversationStartedAt || Date.now(),
    updatedAt: Date.now(),
    provider: S.conversationProvider,
    model: S.conversationModel,
    messageCount: S.state.messages.length,
    messages: snapshotMessagesForSave(S),
    usage: { ...S.state.usage },
    // Persist the provider-neutral S.transcript too, so a resumed session keeps
    // full context (display messages can't reconstruct tool_use/result pairing).
    transcript: [...S.transcript],
    // Persist edits (before/after + status) so resume/restart restores the
    // Changes view and accept/revert keep working — the files are still on disk.
    edits: S.state.edits.map((e) => ({ ...e })),
    // Persist the working plan (Taskboard) so a resumed session keeps it.
    plan: S.state.plan,
  };
  await saveSession(record);
}

export function reset(S: ThreadContainer = activeContainer()): boolean {
  if (containerBusy(S)) return false;
  // Detached background agents are conversation-scoped — abort + drop the leaving
  // conversation's tasks so they never bleed into the next chat.
  cancelBackgroundForConversation(S.conversationId);
  // Clear the S.transcript but KEEP edits the user hasn't decided on yet: those
  // files are still modified on disk, and dropping them would orphan the only
  // in-app affordance to revert (the `before` content lives on the edit). Edits
  // the user already accepted/reverted are resolved, so they drop with the chat.
  const keptEdits = S.state.edits.filter((e) => e.status === 'applied');
  S.state = emptyAgentChatState();
  S.state.edits = keptEdits;
  S.transcript = [];
  // Forget tracked reads — the next conversation starts fresh, so a file read in
  // the prior chat shouldn't gate an edit here.
  clearReadTracker();
  // Drop lazily-injected directory instruction claims so the next conversation
  // re-injects them on demand.
  clearNestedInstructionClaims();
  // Per-turn runtime markers (turn start URL + checkpoint snapshot) are
  // conversation-scoped and session-lived; drop them so they don't accumulate.
  clearTurnRuntimeState();
  // Sticky keyword modes are conversation-scoped — drop them with the chat.
  S.activeModes = [];
  // "Allow always" choices are conversation-scoped — drop them with the chat.
  S.sessionAllowedTools.clear();
  // The prior conversation was persisted on its last turn's finish(); drop its id
  // so the next turn begins (and saves to) a fresh session.
  S.conversationId = null;
  emitContainer(S);
  return true;
}

function sameWorkspace(record: SessionRecord, S: ThreadContainer): boolean {
  return (record.workspaceId ?? null) === (S.workspaceId ?? null);
}

/**
 * Load a saved session as the active conversation (v3 §5-C). Refuses while a turn
 * is in flight. The current conversation was already persisted on its last
 * finish(), so replacing state here loses nothing — including its edits, which
 * went into that record and are recoverable by resuming it again.
 * Restores the resumed session's OWN edits from the record (so its Changes view
 * and accept/revert survive resume/restart), plus the provider-neutral
 * S.transcript when present (sessions saved before these fields resume as
 * read-only history — messages render, but the model has no prior context).
 */
export async function resumeSession(
  id: string,
  S: ThreadContainer = activeContainer(),
): Promise<boolean> {
  if (containerBusy(S)) return false;
  const record = await readSession(id);
  if (!record) return false;
  if (!sameWorkspace(record, S)) return false;
  // Abort the leaving conversation's background agents (a detached child process
  // can't be restored on resume, so the resumed chat starts with none).
  cancelBackgroundForConversation(S.conversationId);
  S.sessionAllowedTools.clear();
  // Forget the prior conversation's tracked reads — same as reset(). A file read
  // in the chat we're leaving must not gate (or wrongly clear staleness on) an
  // edit in the resumed session.
  clearReadTracker();
  clearNestedInstructionClaims();
  S.activeModes = [];
  S.state = emptyAgentChatState();
  // Restore this session's own edits (kept as the leaving chat's were saved on
  // its finish()). Clone so mutating status later can't bleed into the record.
  S.state.edits = record.edits ? record.edits.map((e) => ({ ...e })) : [];
  S.state.plan = record.plan ?? null;
  S.state.messages = record.messages ?? [];
  S.state.usage = record.usage
    ? {
        inputTokens: record.usage.inputTokens,
        outputTokens: record.usage.outputTokens,
        // Older saved sessions predate contextTokens; fall back to the cumulative
        // input total so the gauge isn't blank until the next turn re-measures.
        contextTokens: record.usage.contextTokens ?? record.usage.inputTokens,
      }
    : { inputTokens: 0, outputTokens: 0, contextTokens: 0 };
  S.transcript = record.transcript ? [...record.transcript] : [];
  S.conversationId = record.id;
  S.conversationStartedAt = record.createdAt;
  S.conversationTitle = record.title;
  S.conversationProvider = record.provider;
  S.conversationModel = record.model;
  S.state.activeSessionId = S.conversationId;
  emitContainer(S);
  return true;
}

/** Saved sessions, newest first (summaries only) — backs the sessions UI list. */
export function listSavedSessions(workspaceId?: SessionWorkspaceFilter): Promise<SessionSummary[]> {
  return listSessions(workspaceId);
}

/**
 * Delete a saved session. When it's the live conversation, clear the chat first
 * so the next turn starts fresh; refuses if that conversation is mid-turn.
 */
export async function deleteSavedSession(
  id: string,
  S: ThreadContainer = activeContainer(),
): Promise<boolean> {
  const record = await readSession(id);
  if (!record || !sameWorkspace(record, S)) return false;
  if (S.conversationId === id) {
    if (containerBusy(S)) return false;
    reset(S);
  }
  return deleteSession(id);
}
