import { Circle, CircleDot, CheckCircle2 } from 'lucide-react';
import type { AgentPlan } from '../types';

/**
 * The agent's working plan (Taskboard), mirrored from the PC and rendered
 * read-only on the phone (v5 §G2 parity). Anchored above the composer like the
 * approval/question prompts. Renders nothing when there's no active plan.
 */
export function PlanBoard({ plan }: { plan: AgentPlan | null }) {
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
              <Icon
                size={15}
                style={{
                  marginTop: 2,
                  flexShrink: 0,
                  opacity: step.status === 'pending' ? 0.5 : 1,
                }}
              />
              <div style={{ minWidth: 0 }}>
                <span style={{ textDecoration: step.status === 'done' ? 'line-through' : 'none', opacity: step.status === 'done' ? 0.6 : 1 }}>
                  {step.title}
                </span>
                {step.note ? (
                  <div style={{ fontSize: 12, opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {step.note}
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
