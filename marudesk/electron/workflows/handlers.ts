import { defineHandler } from '../ipc/define-handler';
import { nonEmptyStr, obj } from '../ipc/validate';
import { getActive } from '../browser/state';
import { isWorkflowStepTool, type WorkflowStep } from '../../shared/workflows';
import { deleteWorkflow, listWorkflows, saveWorkflow } from './store';
import { runWorkflow } from './runner';

/**
 * IPC surface for cached browser workflows (§3.10). Save captures the active web
 * tab's URL as the replay start point; the renderer only sends name + steps. All
 * payloads are validated before touching the store / replay engine.
 */

const MAX_STEPS = 200;

function parseSteps(raw: unknown): WorkflowStep[] {
  if (!Array.isArray(raw)) return [];
  const out: WorkflowStep[] = [];
  for (const s of raw.slice(0, MAX_STEPS)) {
    if (!s || typeof s !== 'object') continue;
    const r = s as Record<string, unknown>;
    if (typeof r.tool !== 'string' || !isWorkflowStepTool(r.tool)) continue;
    const input = r.input && typeof r.input === 'object' ? (r.input as Record<string, unknown>) : {};
    out.push({ tool: r.tool, input });
  }
  return out;
}

export function registerWorkflowHandlers(): void {
  defineHandler('workflows:list', () => listWorkflows());

  defineHandler('workflows:save', ([payload]) => {
    const p = obj(payload);
    const name = nonEmptyStr(p.name, 'name');
    const steps = parseSteps(p.steps);
    const active = getActive();
    const startUrl =
      active?.view && active.kind === 'web' ? active.view.webContents.getURL() : null;
    return saveWorkflow({ name, steps, startUrl });
  });

  defineHandler('workflows:delete', ([payload]) =>
    deleteWorkflow(nonEmptyStr(obj(payload).id, 'id')),
  );

  defineHandler('workflows:run', ([payload]) => runWorkflow(nonEmptyStr(obj(payload).id, 'id')));
}
