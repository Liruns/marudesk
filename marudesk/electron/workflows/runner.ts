import type { WorkflowRunResult, WorkflowStepResult } from '../../shared/workflows';
import { EXECUTORS } from '../agent/tools/executors';
import type { ToolContext } from '../agent/tools/types';
import { getActive } from '../browser/state';
import { navigateActive } from '../browser/navigation';
import { getCurrentWorkspace } from '../workspace';
import { getSettingsSync } from '../settings';
import { loadWorkflow } from './store';

/**
 * Replay a saved workflow against the live page WITHOUT the model (§3.10): for
 * each step, call the SAME interaction-tool executor the agent uses, with a
 * hand-built ToolContext (active web tab + workspace). User-initiated, so there's
 * no approval gate — but a tool the user put on `agent.denyTools` is still
 * skipped, mirroring the loop's hard block. Navigates to the recorded page first
 * so replay is deterministic regardless of where the user currently is.
 */

const STEP_DELAY_MS = 150;
const RETRY_DELAY_MS = 400;
const NAV_SETTLE_MS = 600;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function runWorkflow(id: string): Promise<WorkflowRunResult> {
  const wf = await loadWorkflow(id);
  if (!wf) return { ok: false, reason: 'not-found' };

  // Recorded page first — replay assumes that starting point.
  if (wf.startUrl) {
    try {
      await navigateActive(wf.startUrl);
      await sleep(NAV_SETTLE_MS);
    } catch {
      // best-effort; the steps below will fail clearly if there's no live page
    }
  }

  const rec = getActive();
  if (!rec || !rec.view || rec.kind !== 'web') return { ok: false, reason: 'no-web-tab' };

  const ctx: ToolContext = {
    ws: getCurrentWorkspace(),
    tabId: rec.id,
    signal: new AbortController().signal,
  };
  const denyTools = getSettingsSync().agent.denyTools;
  const results: WorkflowStepResult[] = [];
  for (const step of wf.steps) {
    if (denyTools.includes(step.tool)) {
      results.push({ tool: step.tool, ok: false, skipped: true, detail: 'blocked by deny list' });
      continue;
    }
    const exec = EXECUTORS[step.tool];
    if (!exec) {
      results.push({ tool: step.tool, ok: false, detail: 'unknown tool' });
      continue;
    }
    // Run the step; if it fails (e.g. the target element hasn't rendered yet),
    // wait briefly and retry once — replay shouldn't be brittle to page timing.
    let result: WorkflowStepResult | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const out = await exec(step.input, ctx);
        result = { tool: step.tool, ok: !out.isError, detail: out.summary };
      } catch (err) {
        result = { tool: step.tool, ok: false, detail: (err as Error).message };
      }
      if (result.ok) break;
      if (attempt === 0) await sleep(RETRY_DELAY_MS);
    }
    results.push(result!);
    await sleep(STEP_DELAY_MS);
  }
  return { ok: true, results };
}
