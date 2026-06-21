import { memo, useCallback, useEffect, useMemo, useRef, useState, type Ref } from 'react';
import type { AgentEdit, AgentMessage, AgentStatus } from '../../../../shared/agent';
import type { TranscriptVerbosity } from '../store';
import { ChangesSection } from './Cards';
import { MessageView } from './Message';
import { latestChangesRowKey, transcriptRowsWithTurnChanges } from './turn-edits';
import {
  DEFAULT_TRANSCRIPT_WINDOW,
  registerTranscriptReveal,
  transcriptWindow,
} from './useStickyTranscriptScroll';
import { useI18n } from '../../../i18n/useI18n';

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
  const { t } = useI18n();
  const rows = transcriptRowsWithTurnChanges(messages, edits);
  const targetChangesKey = latestChangesRowKey(rows);

  // Bounded mounted-scrollback: only the trailing slice of rows mounts so the
  // DOM stops growing across a long session (see useStickyTranscriptScroll). The
  // cap only ever hides the OLDEST rows, so the live edge — and thus sticky
  // auto-scroll, streaming, and turn dividers near the bottom — are untouched.
  // `reveal` grows as the user clicks "Load earlier" or a search jumps to an old
  // message; it resets whenever the row list shrinks (a new thread / reset).
  const [reveal, setReveal] = useState(DEFAULT_TRANSCRIPT_WINDOW);

  // Row index per message id, so the search-jump registry can map a target
  // message to the reveal count needed to mount it (and everything after it).
  const rowIndexByMessageId = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((row, index) => {
      if (row.kind === 'message') map.set(row.message.id, index);
    });
    return map;
  }, [rows]);

  const total = rows.length;
  const { start, hiddenCount } = transcriptWindow(total, DEFAULT_TRANSCRIPT_WINDOW, reveal);

  // Reset the reveal when switching to a (shorter) conversation so a fresh thread
  // starts from the default tail instead of inheriting a huge reveal.
  const lastTotalRef = useRef(total);
  useEffect(() => {
    if (total < lastTotalRef.current) setReveal(DEFAULT_TRANSCRIPT_WINDOW);
    lastTotalRef.current = total;
  }, [total]);

  // Expose a reveal control to the search sibling. Returns true when the target
  // was off-window (so the search waits a frame for the wider window to render).
  const ensureMessageMounted = useCallback(
    (messageId: string): boolean => {
      const rowIndex = rowIndexByMessageId.get(messageId);
      if (rowIndex === undefined) return false;
      // Rows from this index to the end must mount.
      const needed = total - rowIndex;
      if (needed <= total - start) return false; // already mounted
      setReveal((prev) => Math.max(prev, needed));
      return true;
    },
    [rowIndexByMessageId, total, start],
  );

  useEffect(() => registerTranscriptReveal(ensureMessageMounted), [ensureMessageMounted]);

  const visibleRows = rows.slice(start);

  return (
    <>
      {hiddenCount > 0 ? (
        <button
          type="button"
          onClick={() => setReveal((prev) => prev + DEFAULT_TRANSCRIPT_WINDOW)}
          className="self-center rounded-pill border border-default bg-surface-2 px-3 py-1 text-caption text-fg-secondary shadow-card transition-colors duration-fast hover:bg-surface-3 hover:text-fg-primary"
        >
          {t('agent.chat.loadEarlier').replace('{count}', String(hiddenCount))}
        </button>
      ) : null}
      {visibleRows.map((row) => {
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
