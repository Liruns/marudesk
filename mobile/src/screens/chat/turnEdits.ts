import type { AgentMessage, RemoteEditDiff } from '../../types';

/**
 * Anchor the PC-projected edit diffs into the chat flow (the mobile twin of the
 * desktop's turn-changes rows): each turn's edits render right after that
 * turn's LAST message, so the review card sits under the reply that produced
 * it. Edits whose turn has no message (legacy rows, resumed sessions) trail at
 * the end of the transcript instead of disappearing.
 */
export function attachEditsToMessages(
  messages: AgentMessage[],
  edits: RemoteEditDiff[],
): { byMessageId: Map<string, RemoteEditDiff[]>; trailing: RemoteEditDiff[] } {
  const byMessageId = new Map<string, RemoteEditDiff[]>();
  const trailing: RemoteEditDiff[] = [];
  if (edits.length === 0) return { byMessageId, trailing };

  // Last message id per turn (one pass; later messages overwrite earlier ones).
  const lastMessageOfTurn = new Map<string, string>();
  for (const m of messages) {
    if (m.turnId) lastMessageOfTurn.set(m.turnId, m.id);
  }

  for (const edit of edits) {
    const anchor = lastMessageOfTurn.get(edit.turnId);
    if (anchor === undefined) {
      trailing.push(edit);
      continue;
    }
    const list = byMessageId.get(anchor);
    if (list) list.push(edit);
    else byMessageId.set(anchor, [edit]);
  }
  return { byMessageId, trailing };
}
