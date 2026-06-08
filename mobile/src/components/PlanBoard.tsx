import { Circle, CircleDot, CheckCircle2, X } from 'lucide-react';
import type { AgentPlan, AgentPlanStepStatus } from '../types';
import { useAppStore } from '../store/useAppStore';

/**
 * The agent's working plan (Taskboard), mirrored from the PC. U5 mobile parity:
 * each step is now steerable — tap the status icon to cycle
 * pending → in_progress → done → pending, or the ✕ to remove it. The edit is sent
 * to the host (`edit-plan-step`); the authoritative plan comes back in the next
 * snapshot (no optimistic mutation). Anchored above the composer like the
 * approval/question prompts. Renders nothing when there's no active plan.
 */
const NEXT_STATUS: Record<AgentPlanStepStatus, AgentPlanStepStatus> = {
  pending: 'in_progress',
  in_progress: 'done',
  done: 'pending',
};

export function PlanBoard({ plan }: { plan: AgentPlan | null }) {
  const editPlanStep = useAppStore((s) => s.editPlanStep);
  if (!plan || plan.steps.length === 0) return null;
  const done = plan.steps.filter((s) => s.status === 'done').length;
  const pct = Math.round((done / plan.steps.length) * 100);
  return (
    <div className="plan-board" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, opacity: 0.7 }}>
        <strong style={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}>Plan</strong>
        <span style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>
          {done}/{plan.steps.length}
        </span>
      </div>
      <div style={{ height: 3, borderRadius: 3, background: 'rgba(127,127,127,0.25)', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent, #6aa3ff)' }} />
      </div>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {plan.steps.map((step) => {
          const Icon = step.status === 'done' ? CheckCircle2 : step.status === 'in_progress' ? CircleDot : Circle;
          return (
            <li key={step.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <button
                type="button"
                aria-label={`Cycle status of "${step.title}"`}
                title="Cycle status (pending → in progress → done)"
                onClick={() => void editPlanStep(step.id, { status: NEXT_STATUS[step.status] })}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  marginTop: 2,
                  cursor: 'pointer',
                  flexShrink: 0,
                  color: 'inherit',
                  lineHeight: 0,
                }}
              >
                <Icon size={15} style={{ opacity: step.status === 'pending' ? 0.5 : 1 }} />
              </button>
              <div style={{ minWidth: 0, flex: 1 }}>
                <span style={{ textDecoration: step.status === 'done' ? 'line-through' : 'none', opacity: step.status === 'done' ? 0.6 : 1 }}>
                  {step.title}
                </span>
                {step.note ? (
                  <div style={{ fontSize: 12, opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {step.note}
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                aria-label={`Remove step "${step.title}"`}
                title="Remove step"
                onClick={() => void editPlanStep(step.id, { remove: true })}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 2,
                  marginTop: 1,
                  cursor: 'pointer',
                  flexShrink: 0,
                  color: 'inherit',
                  opacity: 0.45,
                  lineHeight: 0,
                }}
              >
                <X size={13} />
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
