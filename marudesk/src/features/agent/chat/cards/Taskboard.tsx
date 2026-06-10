import { useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDot,
  X,
} from 'lucide-react';
import { useI18n } from '../../../../i18n/useI18n';
import { cn } from '../../../../lib/cn';
import type { AgentPlan, AgentPlanStepStatus } from '../../../../../shared/agent';
import { useAgentStore } from '../../store';

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
