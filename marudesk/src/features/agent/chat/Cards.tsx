import { useState } from 'react';
import {
  AlertCircle,
  Ban,
  Check,
  CheckCircle2,
  ChevronsDownUp,
  ChevronsUpDown,
  Loader2,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import { Badge, Button, DiffBlock } from '../../../components/ui';
import { useI18n } from '../../../i18n/useI18n';
import { cn } from '../../../lib/cn';
import { toast } from '../../../lib/toast';
import type {
  AgentEdit,
  BackgroundTask,
  BackgroundStatus,
  PendingApproval,
  PendingQuestions,
} from '../../../../shared/agent';
import { useAgentStore } from '../store';
import { toDiffLines, diffStats } from '../diff';
import { formatChangedFiles, formatRuntimeChecks, type Receipt } from './format';

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
  const lines = open ? toDiffLines(edit.before, edit.after) : [];

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
      {open ? <DiffBlock filePath={edit.path} lines={lines} className="rounded-none border-0 border-t border-subtle" /> : null}
    </div>
  );
}

/* ── completion receipt (Antigravity "Walkthrough" parity) ──────────────── */

export function ReceiptCard({ receipt }: { receipt: Receipt }) {
  const { locale, t } = useI18n();
  return (
    <div className="rounded-lg border border-subtle bg-surface-1 p-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span className="flex items-center gap-2 text-body-sm text-fg-primary">
        <span className="flex size-5 items-center justify-center rounded-pill bg-success-subtle shrink-0">
          <Check size={12} className="text-success" />
        </span>
        <span className="font-medium">{t('agent.chat.status.done')}</span>
      </span>
      {receipt.verdict ? (
        <Badge variant={receipt.verdict.variant}>{t(receipt.verdict.labelKey)}</Badge>
      ) : null}
      {receipt.runtime > 0 ? (
        <span className="flex items-center gap-1 text-caption text-fg-tertiary tabular-nums">
          <span className="size-1.5 rounded-pill bg-accent shrink-0" aria-hidden />
          {formatRuntimeChecks(locale, receipt.runtime)}
        </span>
      ) : null}
    </div>
  );
}

/* ── approval / questions (parked turns) ────────────────────────────────── */

export function ApprovalCard({ approval }: { approval: PendingApproval }) {
  const { t } = useI18n();
  const approve = useAgentStore((s) => s.approve);
  return (
    <div className="rounded border border-warning/40 bg-warning-subtle/30 p-2.5 flex flex-col gap-2.5">
      <div className="flex items-start gap-2 text-body-sm text-fg-primary">
        <AlertCircle size={14} className="mt-0.5 shrink-0 text-warning" />
        <span className="min-w-0">
          {t('agent.chat.approveBefore')}{' '}
          <span className="font-mono break-all">{approval.name}</span>
          {t('agent.chat.approveAfter')}
        </span>
      </div>
      <pre className="m-0 font-mono text-caption text-fg-secondary whitespace-pre-wrap break-words max-h-32 overflow-y-auto rounded bg-surface-page px-2 py-1.5">
        {approval.detail}
      </pre>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" onClick={() => void approve(approval.callId, true)}>
          {t('agent.chat.approve')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void approve(approval.callId, true, true)}
          title={`${t('agent.chat.allowAlwaysBefore')}${approval.name}${t('agent.chat.allowAlwaysAfter')}`}
        >
          {t('agent.chat.allowAlways')}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void approve(approval.callId, false)}>
          {t('agent.chat.deny')}
        </Button>
      </div>
    </div>
  );
}

export function QuestionsCard({ pending }: { pending: PendingQuestions }) {
  const { t } = useI18n();
  const answer = useAgentStore((s) => s.answer);
  const [values, setValues] = useState<Record<string, string>>({});

  const submit = () => void answer(pending.callId, values);

  return (
    <div className="rounded border border-accent/40 bg-accent-subtle/20 p-2.5 flex flex-col gap-2.5">
      <div className="flex items-center gap-2 text-body-sm text-fg-primary">
        <Sparkles size={14} className="shrink-0 text-accent" /> {t('agent.chat.needsInput')}
      </div>
      {pending.questions.map((q) => (
        <div key={q.id} className="flex flex-col gap-1">
          <span className="text-body-sm text-fg-secondary">{q.question}</span>
          {q.options && q.options.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {q.options.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setValues((v) => ({ ...v, [q.id]: opt }))}
                  className={cn(
                    'h-6 px-2 rounded border text-caption transition-colors duration-fast',
                    values[q.id] === opt
                      ? 'border-accent text-fg-primary bg-accent-subtle/40'
                      : 'border-subtle text-fg-tertiary hover:text-fg-secondary hover:border-default',
                  )}
                >
                  {opt}
                </button>
              ))}
            </div>
          ) : null}
          <input
            value={values[q.id] ?? ''}
            onChange={(e) => setValues((v) => ({ ...v, [q.id]: e.target.value }))}
            placeholder={t('agent.chat.answerPlaceholder')}
            className="h-7 rounded bg-surface-page border border-default px-2 text-body-sm text-fg-primary focus:outline-none focus:border-accent"
          />
        </div>
      ))}
      <Button variant="primary" size="sm" onClick={submit}>
        {t('agent.chat.sendAnswer')}
      </Button>
    </div>
  );
}

/* ── background agents (detached spawn tray) ─────────────────────────────── */

const BG_STATUS_ICON: Record<BackgroundStatus, typeof Loader2> = {
  running: Loader2,
  done: CheckCircle2,
  error: AlertCircle,
  cancelled: Ban,
};

/**
 * The detached background-agent tray (docs/background-agent-design.md §10). A
 * read-only projection of `chat.background`: each task shows its label, model,
 * status, and — when finished — an expandable final report. The model collects
 * results via collect_background_agent; this surface just keeps the user aware.
 */
export function BackgroundTray({ tasks }: { readonly tasks: readonly BackgroundTask[] }) {
  const { t } = useI18n();
  const cancelBackground = useAgentStore((s) => s.cancelBackground);
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set());
  if (!tasks || tasks.length === 0) return null;
  const toggle = (id: string) =>
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-caption uppercase tracking-wider text-fg-tertiary">
        Background agents
      </span>
      {tasks.map((task) => {
        const Icon = BG_STATUS_ICON[task.status];
        const body = task.status === 'done' ? task.result : task.error;
        const expandable = task.status !== 'running' && !!body;
        const open = openIds.has(task.id);
        return (
          <div key={task.id} className="rounded border border-subtle bg-surface-2">
            <div className="flex w-full items-center">
              <button
                type="button"
                disabled={!expandable}
                onClick={() => expandable && toggle(task.id)}
                className={cn(
                  'flex flex-1 items-center gap-2 px-2.5 py-1.5 text-left min-w-0',
                  expandable && 'hover:bg-surface-3',
                )}
              >
                <Icon
                  size={13}
                  className={cn(
                    'shrink-0',
                    task.status === 'running' && 'animate-spin text-fg-tertiary',
                    task.status === 'done' && 'text-success',
                    task.status === 'error' && 'text-error',
                    task.status === 'cancelled' && 'text-fg-tertiary',
                  )}
                />
                <span className="truncate text-body-sm text-fg-primary">{task.label}</span>
                <Badge variant="neutral">
                  {task.provider}/{task.model}
                </Badge>
                <span className="ml-auto shrink-0 text-caption text-fg-tertiary">{task.status}</span>
              </button>
              {task.status === 'running' ? (
                <button
                  type="button"
                  onClick={() => void cancelBackground(task.id)}
                  title={t('agent.chat.background.cancelTitle')}
                  aria-label={t('agent.chat.background.cancelTitle')}
                  className="shrink-0 px-2 py-1.5 text-fg-tertiary hover:text-error transition-colors duration-fast"
                >
                  <Ban size={13} />
                </button>
              ) : null}
            </div>
            {expandable && open ? (
              <div className="border-t border-subtle px-2.5 py-1.5 text-body-sm text-fg-secondary whitespace-pre-wrap break-words">
                {body}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
