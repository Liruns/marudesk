/**
 * Cached browser workflows (docs/runtime-agent-absorption-2026-06.md §3.10/§3.12)
 * — a saved sequence of the agent's page actions, replayable WITHOUT the model.
 * Stored per-workspace under `.marudesk/workflows/*.json` (mirrors steering
 * files). Replay reuses the existing interaction-tool executors, so a workflow is
 * just an ordered list of {tool, input}. Only deterministic page-mutating actions
 * are captured; read-only/eval tools are intentionally excluded.
 */

export type WorkflowStepTool = 'click' | 'fill' | 'press_key' | 'scroll';

export const WORKFLOW_STEP_TOOLS: readonly WorkflowStepTool[] = [
  'click',
  'fill',
  'press_key',
  'scroll',
];

export function isWorkflowStepTool(name: string): name is WorkflowStepTool {
  return (WORKFLOW_STEP_TOOLS as readonly string[]).includes(name);
}

export type WorkflowStep = {
  tool: WorkflowStepTool;
  input: Record<string, unknown>;
};

export type Workflow = {
  id: string;
  name: string;
  /** The page URL the workflow was recorded on; replay navigates here first. */
  startUrl: string | null;
  createdAt: number;
  steps: WorkflowStep[];
};

export type WorkflowStepResult = {
  tool: string;
  ok: boolean;
  detail: string;
  /** True when the step was skipped (e.g. its tool is on the deny list). */
  skipped?: boolean;
};

export type WorkflowRunResult =
  | { ok: true; results: WorkflowStepResult[] }
  | { ok: false; reason: 'not-found' | 'no-web-tab' | 'no-workspace'; message?: string };
