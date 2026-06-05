import type { AgentEdit, AgentMessage } from '../../../../shared/agent';

export type TranscriptRow =
  | {
      readonly kind: 'message';
      readonly message: AgentMessage;
      readonly messageIndex: number;
    }
  | {
      readonly kind: 'changes';
      readonly key: string;
      readonly edits: readonly AgentEdit[];
    };

export function transcriptRowsWithTurnChanges(
  messages: readonly AgentMessage[],
  edits: readonly AgentEdit[],
): TranscriptRow[] {
  const lastMessageIndexByTurnId = new Map<string, number>();
  messages.forEach((message, index) => {
    if (message.turnId) lastMessageIndexByTurnId.set(message.turnId, index);
  });

  const hasExplicitTurnRows = lastMessageIndexByTurnId.size > 0;
  const editsAfterMessageIndex = new Map<number, AgentEdit[]>();
  const orphaned: AgentEdit[] = [];
  for (const edit of edits) {
    const messageIndex = lastMessageIndexByTurnId.get(edit.turnId);
    if (messageIndex !== undefined) {
      appendEdit(editsAfterMessageIndex, messageIndex, edit);
      continue;
    }

    const legacyMessageIndex = hasExplicitTurnRows
      ? null
      : legacyTurnEndIndex(messages, edit.timestamp);
    if (legacyMessageIndex === null) {
      orphaned.push(edit);
      continue;
    }
    appendEdit(editsAfterMessageIndex, legacyMessageIndex, edit);
  }

  const rows: TranscriptRow[] = [];
  if (orphaned.length > 0) {
    rows.push({ kind: 'changes', key: 'changes:unmatched', edits: orphaned });
  }

  messages.forEach((message, index) => {
    rows.push({ kind: 'message', message, messageIndex: index });
    const scopedEdits = editsAfterMessageIndex.get(index);
    if (scopedEdits?.length) {
      rows.push({ kind: 'changes', key: changesKey(message, index), edits: scopedEdits });
    }
  });

  return rows;
}

export function latestChangesRowKey(rows: readonly TranscriptRow[]): string | null {
  let latestKey: string | null = null;
  for (const row of rows) {
    if (row.kind === 'changes') latestKey = row.key;
  }
  return latestKey;
}

function appendEdit(
  editsAfterMessageIndex: Map<number, AgentEdit[]>,
  messageIndex: number,
  edit: AgentEdit,
): void {
  const existing = editsAfterMessageIndex.get(messageIndex);
  if (existing) {
    existing.push(edit);
    return;
  }
  editsAfterMessageIndex.set(messageIndex, [edit]);
}

function legacyTurnEndIndex(
  messages: readonly AgentMessage[],
  editTimestamp: number,
): number | null {
  const latestMessage = messages[messages.length - 1];
  if (!latestMessage || editTimestamp > latestMessage.timestamp) return null;

  let turnStartIndex = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== 'user') continue;
    if (message.timestamp > editTimestamp) break;
    turnStartIndex = index;
  }
  if (turnStartIndex === -1) return null;

  for (let index = turnStartIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === 'user' && message.timestamp > editTimestamp) {
      return index - 1;
    }
  }
  return messages.length - 1;
}

function changesKey(message: AgentMessage, messageIndex: number): string {
  return message.turnId ? `changes:${message.turnId}` : `changes:${message.id}:${messageIndex}`;
}
