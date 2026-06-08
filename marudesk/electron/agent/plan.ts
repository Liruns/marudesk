import type { AgentPlanStep, AgentPlanStepStatus } from '../../shared/agent';
import { S, emit } from './loop-state';
import type { ToolResult } from './tools/types';

/**
 * `update_plan` — loop-intercepted (v5 §G2). The model posts/updates its working
 * plan for multi-step work; we project it onto S.state.plan so the renderer can
 * draw a Taskboard. Each call REPLACES the plan. Plain state update, no side
 * effects, so it's allowed in every approval mode (including plan/read-only) and
 * isn't gated. The parent loop emit()s after the tool returns.
 */

const STATUSES: readonly AgentPlanStepStatus[] = ['pending', 'in_progress', 'done'];
const MAX_PLAN_STEPS = 30;
const MAX_TITLE = 200;
const MAX_NOTE = 300;

/** Stable step id from the title, so a step keeps identity across update_plan
 *  calls (needed for the Taskboard's transcript-jump anchor, §G2/C). */
function slugId(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'step';
}

/**
 * User-driven plan edit (v6 §U5 — steerable plan). Toggle a step's status or
 * remove it, so the plan isn't purely model-owned: the user can check off a step
 * they finished or drop one that's irrelevant. Mutates {@link S.state.plan} in
 * place and emits; the model's next `update_plan` still replaces the whole plan
 * (by stable id, so a status the user set survives until the model revises it).
 * Returns false when the plan/step is gone or the request is a no-op.
 */
export function editPlanStep(
  id: string,
  op: { status?: AgentPlanStepStatus; remove?: boolean },
): boolean {
  const plan = S.state.plan;
  if (!plan) return false;
  let steps = plan.steps;
  if (op.remove) {
    const next = steps.filter((s) => s.id !== id);
    if (next.length === steps.length) return false;
    steps = next;
  } else if (op.status && STATUSES.includes(op.status)) {
    let found = false;
    steps = steps.map((s) => {
      if (s.id !== id) return s;
      found = true;
      return { ...s, status: op.status! };
    });
    if (!found) return false;
  } else {
    return false;
  }
  S.state.plan = steps.length > 0 ? { steps, updatedAt: Date.now() } : null;
  emit();
  return true;
}

export function updatePlanTool(input: unknown): ToolResult {
  const o = (input ?? {}) as { steps?: unknown };
  if (!Array.isArray(o.steps)) {
    return { summary: 'update_plan failed', text: 'update_plan requires a "steps" array.', isError: true };
  }
  // Preserve per-step anchors across updates by stable id. The anchor records the
  // transcript message the agent was at when a step first became active, so the
  // Taskboard can jump there; once set it persists even as statuses change.
  const prevById = new Map((S.state.plan?.steps ?? []).map((s) => [s.id, s]));
  const lastMessageId = S.state.messages[S.state.messages.length - 1]?.id;
  const seen = new Set<string>();
  const steps: AgentPlanStep[] = o.steps.slice(0, MAX_PLAN_STEPS).flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const r = raw as Record<string, unknown>;
    const title = typeof r.title === 'string' ? r.title.trim() : '';
    if (!title) return [];
    const status = STATUSES.includes(r.status as AgentPlanStepStatus)
      ? (r.status as AgentPlanStepStatus)
      : 'pending';
    const note = typeof r.note === 'string' && r.note.trim() ? r.note.trim().slice(0, MAX_NOTE) : undefined;
    let id = slugId(title);
    while (seen.has(id)) id = `${id}-x`;
    seen.add(id);
    const prior = prevById.get(id);
    const anchorMessageId =
      prior?.anchorMessageId ??
      ((status === 'in_progress' || status === 'done') && lastMessageId ? lastMessageId : undefined);
    return [
      {
        id,
        title: title.slice(0, MAX_TITLE),
        status,
        ...(note ? { note } : {}),
        ...(anchorMessageId ? { anchorMessageId } : {}),
      },
    ];
  });
  if (steps.length === 0) {
    return { summary: 'update_plan failed', text: 'No valid steps provided.', isError: true };
  }
  S.state.plan = { steps, updatedAt: Date.now() };
  emit();
  const done = steps.filter((s) => s.status === 'done').length;
  return { summary: `plan: ${done}/${steps.length} done`, text: `Plan updated (${steps.length} steps, ${done} done).` };
}
