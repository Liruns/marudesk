import { useState } from 'react';
import { useStore } from 'zustand';
import { Check, ListTree, Loader2, Plus, User, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useI18n } from '../../i18n/useI18n';
import type { WorkspaceId } from '../../../shared/workspace';
import type { AgentPlanStep, AgentPlanStepStatus } from '../../../shared/agent';
import { getAgentStoreForWorkspace } from '../agent/store';

/**
 * The agent's plan rendered as a distinct process graph — a vertical chain of
 * status nodes wired together — floating over the canvas, NOT a free tool card.
 * That separation is the point: tool cards are *tools* (browser/editor/terminal/
 * chat), this is the AI's *work* (what it's doing / will do). A person can steer
 * it directly: cycle a step's status, remove a step, or insert their own node
 * (which survives the model's next plan replace — see plan.ts `userAdded`). It
 * mirrors the focused workspace's agent plan, so it reflects the chat you're in.
 */

const NEXT: Record<AgentPlanStepStatus, AgentPlanStepStatus> = {
  pending: 'in_progress',
  in_progress: 'done',
  done: 'pending',
};

export function CanvasPlanFlow({
  workspaceId,
  onClose,
}: {
  workspaceId?: WorkspaceId;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const store = getAgentStoreForWorkspace(workspaceId);
  const plan = useStore(store, (s) => s.chat.plan);
  const editPlanStep = useStore(store, (s) => s.editPlanStep);
  const [draft, setDraft] = useState('');

  // Only a surface for an *existing* process; with no plan there's nothing to map.
  if (!plan || plan.steps.length === 0) return null;
  const done = plan.steps.filter((s) => s.status === 'done').length;

  const append = () => {
    const title = draft.trim();
    if (!title) return;
    void editPlanStep('', { add: { title } });
    setDraft('');
  };

  return (
    <aside
      className="absolute right-4 top-4 z-40 flex max-h-[min(72%,34rem)] w-72 flex-col rounded-lg chrome-panel shadow-lifted"
      aria-label={t('agent.flow.title')}
    >
      <header className="flex items-center gap-2 border-b border-subtle px-3 py-2">
        <ListTree size={14} className="shrink-0 text-accent" aria-hidden />
        <span className="flex-1 truncate text-caption font-medium text-fg-secondary">
          {t('agent.flow.title')}
        </span>
        <span className="text-caption tabular-nums text-fg-tertiary">
          {done}/{plan.steps.length}
        </span>
        <button
          type="button"
          aria-label={t('agent.flow.hide')}
          title={t('agent.flow.hide')}
          onClick={onClose}
          className="grid size-5 place-items-center rounded text-fg-tertiary transition-colors duration-fast hover:bg-surface-3 hover:text-fg-primary"
        >
          <X size={13} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {plan.steps.map((step, i) => (
          <PlanNode
            key={step.id}
            step={step}
            last={i === plan.steps.length - 1}
            cycleLabel={t('agent.flow.cycle')}
            removeLabel={t('agent.flow.remove')}
            addLabel={t('agent.flow.addAfter')}
            userLabel={t('agent.flow.userAdded')}
            onCycle={() => void editPlanStep(step.id, { status: NEXT[step.status] })}
            onRemove={() => void editPlanStep(step.id, { remove: true })}
            onAddAfter={() =>
              void editPlanStep('', { add: { title: t('agent.flow.newStep'), after: step.id } })
            }
          />
        ))}
      </div>

      <footer className="border-t border-subtle p-2">
        <div className="flex items-center gap-1.5 rounded-md border border-default/60 bg-surface-2/60 px-2 py-1 transition-colors duration-fast focus-within:border-accent/60">
          <Plus size={13} className="shrink-0 text-fg-tertiary" aria-hidden />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                append();
              }
            }}
            placeholder={t('agent.flow.addPlaceholder')}
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-caption text-fg-primary placeholder:text-fg-tertiary outline-none"
          />
        </div>
      </footer>
    </aside>
  );
}

function PlanNode({
  step,
  last,
  cycleLabel,
  removeLabel,
  addLabel,
  userLabel,
  onCycle,
  onRemove,
  onAddAfter,
}: {
  step: AgentPlanStep;
  last: boolean;
  cycleLabel: string;
  removeLabel: string;
  addLabel: string;
  userLabel: string;
  onCycle: () => void;
  onRemove: () => void;
  onAddAfter: () => void;
}) {
  const ctrl =
    'grid size-5 place-items-center rounded text-fg-tertiary hover:bg-surface-3 hover:text-fg-primary transition-colors duration-fast';
  return (
    <div className="group relative flex gap-2">
      {/* Rail: the status node + the connector down to the next node. */}
      <div className="flex flex-col items-center">
        <button
          type="button"
          onClick={onCycle}
          aria-label={cycleLabel}
          title={cycleLabel}
          className={cn(
            'mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border transition-colors duration-fast',
            step.status === 'done'
              ? 'border-success bg-success text-white'
              : step.status === 'in_progress'
                ? 'border-accent text-accent'
                : 'border-strong text-transparent hover:border-accent',
          )}
        >
          {step.status === 'done' ? (
            <Check size={10} strokeWidth={3} />
          ) : step.status === 'in_progress' ? (
            <Loader2 size={10} className="animate-spin" />
          ) : null}
        </button>
        {!last ? (
          <span
            className="my-1 w-px flex-1"
            style={{ backgroundColor: 'var(--border-strong)' }}
            aria-hidden
          />
        ) : null}
      </div>

      {/* Content: title, the user-added marker, and hover controls. */}
      <div className="min-w-0 flex-1 pb-3">
        <div className="flex items-start gap-1">
          <p
            className={cn(
              'min-w-0 flex-1 text-caption leading-snug',
              step.status === 'done' ? 'text-fg-tertiary line-through' : 'text-fg-secondary',
            )}
          >
            {step.title}
          </p>
          {step.userAdded ? (
            <User size={11} className="mt-0.5 shrink-0 text-accent/70" aria-label={userLabel} />
          ) : null}
          <div className="flex shrink-0 items-center opacity-0 transition-opacity duration-fast group-hover:opacity-100">
            <button type="button" onClick={onAddAfter} aria-label={addLabel} title={addLabel} className={ctrl}>
              <Plus size={11} />
            </button>
            <button type="button" onClick={onRemove} aria-label={removeLabel} title={removeLabel} className={ctrl}>
              <X size={11} />
            </button>
          </div>
        </div>
        {step.note ? (
          <p className="mt-0.5 truncate text-[11px] text-fg-tertiary" title={step.note}>
            {step.note}
          </p>
        ) : null}
      </div>
    </div>
  );
}
