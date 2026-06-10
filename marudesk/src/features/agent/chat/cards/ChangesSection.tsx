import { useState } from 'react';
import {
  Check,
  ChevronsDownUp,
  ChevronsUpDown,
  MessageSquare,
  RotateCcw,
} from 'lucide-react';
import { Badge, DiffBlock } from '../../../../components/ui';
import { useI18n } from '../../../../i18n/useI18n';
import { toast } from '../../../../lib/toast';
import type { AgentEdit } from '../../../../../shared/agent';
import { useAgentStore, useAgentBusy } from '../../store';
import { toDiffLines, diffStats } from '../../diff';
import { formatChangedFiles } from '../format';
import {
  useDiffCommentsStore,
  countDiffComments,
  composeDiffCommentsPrompt,
} from '../diffComments';

/* ── edits (P2: accept / revert) ────────────────────────────────────────── */

/** Surface a refused/failed revert instead of a silent no-op (audit H3). */
function toastRevertFailure(t: ReturnType<typeof useI18n>['t'], stale: boolean): void {
  toast({
    title: t('agent.chat.toast.revertFailed.title'),
    description: t(
      stale ? 'agent.chat.toast.revertFailed.stale' : 'agent.chat.toast.revertFailed.description',
    ),
    variant: 'error',
  });
}

export function ChangesSection({ edits }: { readonly edits: readonly AgentEdit[] }) {
  const { locale, t } = useI18n();
  const acceptEdit = useAgentStore((s) => s.acceptEdit);
  const revertEdit = useAgentStore((s) => s.revertEdit);
  const restoreTurnPage = useAgentStore((s) => s.restoreTurnPage);
  const submitPrompt = useAgentStore((s) => s.submitPrompt);
  const busy = useAgentBusy();
  // Inline review comments the user has staged on these diffs (v6 §U1). When any
  // exist, the header shows a "Send N comments" action that composes them into one
  // feedback turn for the agent, then clears them.
  const commentsByEdit = useDiffCommentsStore((s) => s.byEdit);
  const clearComments = useDiffCommentsStore((s) => s.clearAll);
  const commentCount = countDiffComments(commentsByEdit);
  const sendComments = async () => {
    const prompt = composeDiffCommentsPrompt(edits, commentsByEdit, t);
    const res = await submitPrompt(prompt);
    if (res.ok) clearComments();
    else if (res.reason && res.reason !== 'busy') {
      toast({ title: t('agent.chat.comments.sendFailed'), description: res.reason, variant: 'error' });
    }
  };
  // Which file diffs are expanded. "Expand all" fills it; per-file toggles flip
  // a single id. Kept here (not per card) so the bulk control can drive them.
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set());

  const totals = edits.reduce(
    (acc, e) => {
      const { added, removed } = diffStats(e.before, e.after);
      acc.added += added;
      acc.removed += removed;
      return acc;
    },
    { added: 0, removed: 0 },
  );
  const applied = edits.filter((e) => e.status === 'applied');
  const allOpen = edits.length > 0 && openIds.size === edits.length;

  const toggleOne = (id: string) =>
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setOpenIds(allOpen ? new Set() : new Set(edits.map((e) => e.id)));

  return (
    <div className="flex flex-col gap-2">
      {/* Aggregate review header: file count + total +/- across the turn, with
          bulk keep/revert and expand-all (Zed / Codex multi-file review parity). */}
      <div className="flex items-center gap-2 text-caption">
        <span className="uppercase tracking-wider text-fg-tertiary">
          {formatChangedFiles(locale, edits.length)}
        </span>
        <span className="tabular-nums text-success">+{totals.added}</span>
        <span className="tabular-nums text-error">−{totals.removed}</span>
        <span className="flex-1" aria-hidden />
        {commentCount > 0 ? (
          <button
            type="button"
            onClick={() => void sendComments()}
            disabled={busy}
            className="flex items-center gap-1 text-accent hover:text-accent-hover transition-colors duration-fast disabled:opacity-50 disabled:cursor-not-allowed"
            title={t('agent.chat.comments.sendTitle')}
          >
            <MessageSquare size={12} /> {t('agent.chat.comments.send')} ({commentCount})
          </button>
        ) : null}
        {applied.length > 0 ? (
          <>
            <button
              type="button"
              onClick={() => applied.forEach((e) => void acceptEdit(e.id))}
              className="flex items-center gap-1 text-fg-tertiary hover:text-accent transition-colors duration-fast"
              title={t('agent.chat.keepAllTitle')}
            >
              <Check size={12} /> {t('agent.chat.keepAll')}
            </button>
            <button
              type="button"
              onClick={async () => {
                const results = await Promise.all(applied.map((e) => revertEdit(e.id)));
                const failed = results.filter((r) => !r.ok);
                if (failed.length > 0) {
                  toastRevertFailure(t, failed.some((r) => r.reason === 'stale'));
                }
                // Runtime-aware rollback: also restore the page to where the turn
                // started (no-op unless the agent navigated it). All edits in this
                // card share a turn.
                const turnId = applied[0]?.turnId;
                if (turnId) void restoreTurnPage(turnId);
              }}
              className="flex items-center gap-1 text-fg-tertiary hover:text-error transition-colors duration-fast"
              title={t('agent.chat.revertAllTitle')}
            >
              <RotateCcw size={12} /> {t('agent.chat.revertAll')}
            </button>
          </>
        ) : null}
        <button
          type="button"
          onClick={toggleAll}
          aria-label={allOpen ? t('agent.chat.collapseDiffs') : t('agent.chat.expandDiffs')}
          title={allOpen ? t('agent.chat.collapseDiffs') : t('agent.chat.expandDiffs')}
          className="text-fg-tertiary hover:text-fg-secondary transition-colors duration-fast"
        >
          {allOpen ? <ChevronsDownUp size={13} /> : <ChevronsUpDown size={13} />}
        </button>
      </div>
      {edits.map((e) => (
        <EditCard
          key={e.id}
          edit={e}
          open={openIds.has(e.id)}
          onToggle={() => toggleOne(e.id)}
        />
      ))}
    </div>
  );
}

function EditCard({
  edit,
  open,
  onToggle,
}: {
  edit: AgentEdit;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const acceptEdit = useAgentStore((s) => s.acceptEdit);
  const revertEdit = useAgentStore((s) => s.revertEdit);
  const comments = useDiffCommentsStore((s) => s.byEdit[edit.id]);
  const setComment = useDiffCommentsStore((s) => s.setComment);
  const lines = open ? toDiffLines(edit.before, edit.after) : [];
  const commentCount = comments ? Object.keys(comments).length : 0;

  return (
    <div className="rounded border border-subtle bg-surface-1">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <Badge variant={edit.kind === 'create' ? 'success' : 'neutral'}>{edit.kind}</Badge>
        <button
          type="button"
          onClick={onToggle}
          className="font-mono text-caption text-fg-secondary truncate flex-1 text-left hover:text-fg-primary"
          title={edit.path}
        >
          {edit.path}
        </button>
        {commentCount > 0 ? (
          <span
            className="flex items-center gap-0.5 text-caption text-accent shrink-0"
            title={t('agent.chat.comments.count')}
          >
            <MessageSquare size={11} /> {commentCount}
          </span>
        ) : null}
        {edit.status === 'applied' ? (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => void acceptEdit(edit.id)}
              className="flex items-center gap-1 text-caption text-fg-tertiary hover:text-accent transition-colors duration-fast"
              title={t('agent.chat.keepTitle')}
            >
              <Check size={12} /> {t('agent.chat.keep')}
            </button>
            <button
              type="button"
              onClick={async () => {
                const res = await revertEdit(edit.id);
                if (!res.ok) toastRevertFailure(t, res.reason === 'stale');
              }}
              className="flex items-center gap-1 text-caption text-fg-tertiary hover:text-error transition-colors duration-fast"
              title={t('agent.chat.revertTitle')}
            >
              <RotateCcw size={12} /> {t('agent.chat.revert')}
            </button>
          </div>
        ) : (
          <Badge variant={edit.status === 'reverted' ? 'warning' : 'success'}>
            {edit.status === 'reverted' ? t('agent.chat.reverted') : t('agent.chat.kept')}
          </Badge>
        )}
      </div>
      {open ? (
        <DiffBlock
          filePath={edit.path}
          lines={lines}
          className="rounded-none border-0 border-t border-subtle"
          comments={comments}
          onCommentChange={(lineIndex, text) => setComment(edit.id, lineIndex, text)}
        />
      ) : null}
    </div>
  );
}
