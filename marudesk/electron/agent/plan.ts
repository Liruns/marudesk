import type { AgentPlanStep, AgentPlanStepStatus } from '../../shared/agent';
import { S, emit, emitContainer } from './loop-state';
import type { ToolContext, ToolResult } from './tools/types';

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
  op: {
    status?: AgentPlanStepStatus;
    remove?: boolean;
    /** Rename an existing step's title. */
    title?: string;
    /** Insert a person-authored step (steering); persists across update_plan. */
    add?: { title: string; after?: string };
  },
): boolean {
  // Add a user step: works even with no plan yet (creates one). Inserted after
  // `after` when given, else appended. Marked userAdded so the model's next
  // update_plan keeps it instead of replacing it away.
  if (op.add) {
    const title = op.add.title.trim().slice(0, MAX_TITLE);
    if (!title) return false;
    const steps = S.state.plan ? [...S.state.plan.steps] : [];
    let stepId = slugId(title);
    while (steps.some((s) => s.id === stepId)) stepId = `${stepId}-x`;
    const node: AgentPlanStep = { id: stepId, title, status: 'pending', userAdded: true };
    const afterIdx = op.add.after ? steps.findIndex((s) => s.id === op.add!.after) : -1;
    if (afterIdx >= 0) steps.splice(afterIdx + 1, 0, node);
    else steps.push(node);
    S.state.plan = { steps, updatedAt: Date.now() };
    emit();
    return true;
  }

  const plan = S.state.plan;
  if (!plan) return false;
  let steps = plan.steps;
  if (op.remove) {
    const next = steps.filter((s) => s.id !== id);
    if (next.length === steps.length) return false;
    steps = next;
  } else if (op.title !== undefined) {
    const title = op.title.trim().slice(0, MAX_TITLE);
    if (!title) return false;
    let found = false;
    steps = steps.map((s) => {
      if (s.id !== id) return s;
      found = true;
      return { ...s, title };
    });
    if (!found) return false;
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

export function updatePlanTool(input: unknown, ctx?: ToolContext): ToolResult {
  // Write to the TURN's thread (Stage 12-B-2) so a non-active thread's plan
  // update doesn't clobber the active thread's Taskboard; fall back to active.
  const T = ctx?.thread ?? S;
  const o = (input ?? {}) as { steps?: unknown };
  if (!Array.isArray(o.steps)) {
    return { summary: 'update_plan failed', text: 'update_plan requires a "steps" array.', isError: true };
  }
  // Preserve per-step anchors across updates by stable id. The anchor records the
  // transcript message the agent was at when a step first became active, so the
  // Taskboard can jump there; once set it persists even as statuses change.
  const prevById = new Map((T.state.plan?.steps ?? []).map((s) => [s.id, s]));
  const lastMessageId = T.state.messages[T.state.messages.length - 1]?.id;
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
  // Keep any person-authored steps the model didn't re-list (steering survives a
  // full plan replace) — appended after the model's, so they never vanish.
  const userSteps = (T.state.plan?.steps ?? []).filter((s) => s.userAdded && !seen.has(s.id));
  const merged = userSteps.length > 0 ? [...steps, ...userSteps] : steps;
  T.state.plan = { steps: merged, updatedAt: Date.now() };
  emitContainer(T);
  const done = merged.filter((s) => s.status === 'done').length;
  return { summary: `plan: ${done}/${merged.length} done`, text: `Plan updated (${merged.length} steps, ${done} done).` };
}
