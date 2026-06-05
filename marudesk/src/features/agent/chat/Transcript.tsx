import { memo, type Ref } from 'react';
import type { AgentEdit, AgentMessage, AgentStatus } from '../../../../shared/agent';
import type { TranscriptVerbosity } from '../store';
import { ChangesSection } from './Cards';
import { MessageView } from './Message';
import { latestChangesRowKey, transcriptRowsWithTurnChanges } from './turn-edits';

export const Transcript = memo(function Transcript({
  messages,
  edits,
  status,
  verbosity,
  changesRef,
}: {
  readonly messages: readonly AgentMessage[];
  readonly edits: readonly AgentEdit[];
  readonly status: AgentStatus;
  readonly verbosity: TranscriptVerbosity;
  readonly changesRef?: Ref<HTMLDivElement>;
}) {
  const rows = transcriptRowsWithTurnChanges(messages, edits);
  const targetChangesKey = latestChangesRowKey(rows);

  return (
    <>
      {rows.map((row) => {
        if (row.kind === 'message') {
          return (
            <MessageView
              key={row.message.id}
              message={row.message}
              streaming={status === 'thinking' && row.messageIndex === messages.length - 1}
              verbosity={verbosity}
            />
          );
        }

        const ref = row.key === targetChangesKey ? changesRef : undefined;
        return (
          <div key={row.key} ref={ref}>
            <ChangesSection edits={row.edits} />
          </div>
        );
      })}
    </>
  );
});
