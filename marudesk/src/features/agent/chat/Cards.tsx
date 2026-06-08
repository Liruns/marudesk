import { useState } from 'react';
import {
  AlertCircle,
  Ban,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Circle,
  CircleDot,
  Camera,
  Loader2,
  MessageSquare,
  RotateCcw,
  Sparkles,
  X,
} from 'lucide-react';
import { Badge, Button, DiffBlock } from '../../../components/ui';
import { useI18n } from '../../../i18n/useI18n';
import { cn } from '../../../lib/cn';
import { toast } from '../../../lib/toast';
import type {
  AgentEdit,
  AgentPlan,
  AgentPlanStepStatus,
  BackgroundTask,
  BackgroundStatus,
  PendingApproval,
  PendingQuestions,
} from '../../../../shared/agent';
import { useAgentStore, useAgentBusy } from '../store';
import { toDiffLines, diffStats } from '../diff';
import { formatChangedFiles, formatRuntimeChecks, type Receipt } from './format';
import {
  useDiffCommentsStore,
  countDiffComments,
  composeDiffCommentsPrompt,
} from './diffComments';

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

/* ── completion receipt (Antigravity "Walkthrough" parity) ──────────────── */

export function ReceiptCard({ receipt }: { receipt: Receipt }) {
  const { locale, t } = useI18n();
  // Running-app snapshot (benchmark Top8): captured on demand so a base64 image
  // never enters the agent snapshot / session persistence. null = not captured;
  // '' = captured but no web view to grab.
  const [shot, setShot] = useState<string | null>(null);
  const [shooting, setShooting] = useState(false);
  const capture = async () => {
    setShooting(true);
    try {
      const res = await window.marudesk.invoke('browser:capture-page-data');
      setShot(res ? res.dataUrl : '');
    } catch {
      setShot('');
    } finally {
      setShooting(false);
    }
  };
  return (
    <div className="rounded-lg border border-subtle bg-surface-1 p-3 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
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
        <span className="flex-1" aria-hidden />
        <button
          type="button"
          onClick={() => void capture()}
          disabled={shooting}
          title={t('agent.chat.receipt.snapshotTitle')}
          className="flex items-center gap-1 text-caption text-fg-tertiary hover:text-accent transition-colors duration-fast disabled:opacity-50"
        >
          <Camera size={12} /> {t('agent.chat.receipt.snapshot')}
        </button>
      </div>
      {shot ? (
        <img
          src={shot}
          alt={t('agent.chat.receipt.snapshotAlt')}
          className="w-full rounded border border-subtle"
        />
      ) : shot === '' ? (
        <span className="text-caption text-fg-tertiary">
          {t('agent.chat.receipt.snapshotNone')}
        </span>
      ) : null}
    </div>
  );
}

/* ── approval / questions (parked turns) ────────────────────────────────── */

export function ApprovalCard({ approval }: { approval: PendingApproval }) {
  const { t } = useI18n();
  const approve = useAgentStore((s) => s.approve);
  const isEdit = !!approval.diffs && approval.diffs.length > 0;
  return (
    <div className="rounded border border-warning/40 bg-warning-subtle/30 p-2.5 flex flex-col gap-2.5">
      <div className="flex items-start gap-2 text-body-sm text-fg-primary">
        <AlertCircle size={14} className="mt-0.5 shrink-0 text-warning" />
        <span className="min-w-0">
          {isEdit ? (
            t('agent.chat.reviewEdit')
          ) : (
            <>
              {t('agent.chat.approveBefore')}{' '}
              <span className="font-mono break-all">{approval.name}</span>
              {t('agent.chat.approveAfter')}
            </>
          )}
        </span>
      </div>
      {approval.diffs && approval.diffs.length > 0 ? (
        <div className="flex max-h-64 flex-col gap-1.5 overflow-y-auto">
          {approval.diffs.map((d, i) => (
            <DiffBlock
              key={`${d.path}-${i}`}
              filePath={d.path}
              lines={toDiffLines(d.before || null, d.after)}
            />
          ))}
        </div>
      ) : (
        <pre className="m-0 font-mono text-caption text-fg-secondary whitespace-pre-wrap break-words max-h-32 overflow-y-auto rounded bg-surface-page px-2 py-1.5">
          {approval.detail}
        </pre>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" onClick={() => void approve(approval.callId, true)}>
          {isEdit ? t('agent.chat.apply') : t('agent.chat.approve')}
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

/* ── error recovery (v6 §W5/U4) ──────────────────────────────────────────── */

type RecoveryKey =
  | 'agent.chat.recovery.suggest.apiKey'
  | 'agent.chat.recovery.suggest.permission'
  | 'agent.chat.recovery.suggest.notFound'
  | 'agent.chat.recovery.suggest.timeout'
  | 'agent.chat.recovery.suggest.rateLimit'
  | 'agent.chat.recovery.suggest.generic';

/** Map a failure message to a plain-language next step (heuristic, best-effort). */
function recoverySuggestion(error: string): RecoveryKey {
  const e = error.toLowerCase();
  if (/api key|unauthor|\b401\b|invalid.*key/.test(e)) return 'agent.chat.recovery.suggest.apiKey';
  if (/permission|denied|eacces|blocked|deny glob/.test(e)) return 'agent.chat.recovery.suggest.permission';
  if (/not found|enoent|no such file|oldstring not found/.test(e)) return 'agent.chat.recovery.suggest.notFound';
  if (/timeout|timed out/.test(e)) return 'agent.chat.recovery.suggest.timeout';
  if (/rate limit|\b429\b|quota|overloaded/.test(e)) return 'agent.chat.recovery.suggest.rateLimit';
  return 'agent.chat.recovery.suggest.generic';
}

/**
 * Shown in place of a bare failed-turn error string (v6 §W5/U4): the full error
 * (expandable), a heuristic next-step hint, and a one-click Retry — optionally
 * steered by a short instruction — that re-prompts the agent with the failure
 * context instead of leaving the user to retype everything. Replaces the previous
 * static, truncated error line.
 */
export function ErrorRecoveryCard({ error }: { error: string }) {
  const { t } = useI18n();
  const submitPrompt = useAgentStore((s) => s.submitPrompt);
  const busy = useAgentBusy();
  const [guidance, setGuidance] = useState('');
  const [expanded, setExpanded] = useState(false);
  const long = error.length > 200;

  const retry = async () => {
    const tail = guidance.trim() || t('agent.chat.recovery.defaultTail');
    const prompt = `${t('agent.chat.recovery.promptHeader')}\n\n${error}\n\n${tail}`;
    const res = await submitPrompt(prompt);
    if (res.ok) setGuidance('');
    else if (res.reason && res.reason !== 'busy') {
      toast({ title: t('agent.chat.recovery.retryFailed'), description: res.reason, variant: 'error' });
    }
  };

  return (
    <div className="rounded border border-error/40 bg-error-subtle/40 p-2.5 flex flex-col gap-2">
      <div className="flex items-start gap-2 text-body-sm text-fg-primary">
        <AlertCircle size={14} className="mt-0.5 shrink-0 text-error" />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="break-words">
            {long && !expanded ? `${error.slice(0, 200)}…` : error}
          </span>
          {long ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="self-start text-caption text-fg-tertiary hover:text-fg-secondary transition-colors duration-fast"
            >
              {expanded ? t('agent.chat.recovery.less') : t('agent.chat.recovery.more')}
            </button>
          ) : null}
          <span className="text-caption text-fg-tertiary">{t(recoverySuggestion(error))}</span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <input
          value={guidance}
          onChange={(e) => setGuidance(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !busy) {
              e.preventDefault();
              void retry();
            }
          }}
          placeholder={t('agent.chat.recovery.guidancePlaceholder')}
          className="h-7 flex-1 rounded bg-surface-page border border-default px-2 text-body-sm text-fg-primary focus:outline-none focus:border-accent"
        />
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void retry()}>
          <RotateCcw size={12} /> {t('agent.chat.recovery.retry')}
        </Button>
      </div>
    </div>
  );
}

/* ── plan / taskboard (v5 §G2) ───────────────────────────────────────────── */

const PLAN_STATUS_ICON: Record<AgentPlanStepStatus, typeof Circle> = {
  pending: Circle,
  in_progress: CircleDot,
  done: CheckCircle2,
};

/** Click-cycle order for a step's status (v6 §U5 steerable plan). */
const NEXT_PLAN_STATUS: Record<AgentPlanStepStatus, AgentPlanStepStatus> = {
  pending: 'in_progress',
  in_progress: 'done',
  done: 'pending',
};

/** Scroll the transcript to the message a plan step is anchored to (§G2/C). The
 *  message rows carry `id="agent-msg-<id>"`; scrollIntoView finds its scroll
 *  ancestor on its own, so this works for both the full surface and the drawer. */
function jumpToMessage(messageId: string): void {
  const el = document.getElementById(`agent-msg-${messageId}`);
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/**
 * The agent's working plan, rendered as a compact Taskboard (v5 §G2). A read-only
 * projection of `chat.plan`, maintained by the model via the update_plan tool:
 * an ordered step list with status icons + a progress bar so the user can follow
 * multi-step work. Renders nothing when there's no active plan.
 */
export function Taskboard({ plan }: { readonly plan: AgentPlan | null }) {
  const { t } = useI18n();
  const editPlanStep = useAgentStore((s) => s.editPlanStep);
  const [open, setOpen] = useState(true);
  if (!plan || plan.steps.length === 0) return null;
  const done = plan.steps.filter((s) => s.status === 'done').length;
  const pct = Math.round((done / plan.steps.length) * 100);
  return (
    <div className="flex flex-col gap-1.5 rounded border border-subtle bg-surface-2 p-2.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-caption uppercase tracking-wider text-fg-tertiary hover:text-fg-secondary transition-colors duration-fast"
        aria-expanded={open}
      >
        {open ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
        <span>{t('agent.chat.plan.title')}</span>
        <span className="ml-auto tabular-nums">
          {done}/{plan.steps.length}
        </span>
      </button>
      <div className="h-1 w-full overflow-hidden rounded bg-surface-3">
        <div className="h-full bg-accent transition-all duration-fast" style={{ width: `${pct}%` }} />
      </div>
      {open ? (
        <ol className="flex flex-col gap-1">
          {plan.steps.map((step) => {
            const Icon = PLAN_STATUS_ICON[step.status];
            const jumpable = !!step.anchorMessageId;
            return (
              <li
                key={step.id}
                className="group flex items-start gap-2 rounded px-1 py-0.5 text-body-sm hover:bg-surface-3 transition-colors duration-fast"
              >
                {/* Status icon = click to cycle pending → in_progress → done (§U5). */}
                <button
                  type="button"
                  onClick={() => void editPlanStep(step.id, { status: NEXT_PLAN_STATUS[step.status] })}
                  title={t('agent.chat.plan.toggle')}
                  aria-label={t('agent.chat.plan.toggle')}
                  className="mt-0.5 shrink-0"
                >
                  <Icon
                    size={13}
                    className={cn(
                      step.status === 'done' && 'text-success',
                      step.status === 'in_progress' && 'text-accent',
                      step.status === 'pending' && 'text-fg-tertiary',
                    )}
                  />
                </button>
                {/* Title = jump to where the step was worked on (when anchored). */}
                <button
                  type="button"
                  disabled={!jumpable}
                  onClick={() => jumpable && jumpToMessage(step.anchorMessageId!)}
                  title={jumpable ? t('agent.chat.plan.jump') : undefined}
                  className={cn('min-w-0 flex-1 text-left', jumpable && 'cursor-pointer')}
                >
                  <span
                    className={cn(
                      step.status === 'done' ? 'text-fg-tertiary line-through' : 'text-fg-primary',
                    )}
                  >
                    {step.title}
                  </span>
                  {step.note ? (
                    <div className="truncate text-caption text-fg-tertiary">{step.note}</div>
                  ) : null}
                </button>
                <button
                  type="button"
                  onClick={() => void editPlanStep(step.id, { remove: true })}
                  title={t('agent.chat.plan.remove')}
                  aria-label={t('agent.chat.plan.remove')}
                  className="shrink-0 opacity-0 group-hover:opacity-100 text-fg-tertiary hover:text-error transition-all duration-fast"
                >
                  <X size={12} />
                </button>
              </li>
            );
          })}
        </ol>
      ) : null}
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
