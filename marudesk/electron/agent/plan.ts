import type { AgentPlanStep, AgentPlanStepStatus } from '../../shared/agent';
import { S, emit, uid } from './loop-state';
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

export function updatePlanTool(input: unknown): ToolResult {
  const o = (input ?? {}) as { steps?: unknown };
  if (!Array.isArray(o.steps)) {
    return { summary: 'update_plan failed', text: 'update_plan requires a "steps" array.', isError: true };
  }
  const steps: AgentPlanStep[] = o.steps.slice(0, MAX_PLAN_STEPS).flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const r = raw as Record<string, unknown>;
    const title = typeof r.title === 'string' ? r.title.trim() : '';
    if (!title) return [];
    const status = STATUSES.includes(r.status as AgentPlanStepStatus)
      ? (r.status as AgentPlanStepStatus)
      : 'pending';
    const note = typeof r.note === 'string' && r.note.trim() ? r.note.trim().slice(0, MAX_NOTE) : undefined;
    return [{ id: uid('step'), title: title.slice(0, MAX_TITLE), status, ...(note ? { note } : {}) }];
  });
  if (steps.length === 0) {
    return { summary: 'update_plan failed', text: 'No valid steps provided.', isError: true };
  }
  S.state.plan = { steps, updatedAt: Date.now() };
  emit();
  const done = steps.filter((s) => s.status === 'done').length;
  return { summary: `plan: ${done}/${steps.length} done`, text: `Plan updated (${steps.length} steps, ${done} done).` };
}
