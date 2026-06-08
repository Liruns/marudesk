import { clipText } from '../../shared/text-clip';
import { isProviderId } from '../../shared/providers';
import type { WorkspaceSummary } from '../../shared/workspace';
import type { Automation, AutomationRun } from '../../shared/automations';
import { runChildAgent } from '../agent/subagent-runtime';
import type { ToolContext } from '../agent/tools/types';
import type { AutomationRunner } from './scheduler';

/**
 * Production automation runner (Stage 12-C). Executes a saved automation as a
 * detached, READ-ONLY agent — the same non-gated child toolset as a background
 * agent, further narrowed by the automation's per-automation `allowTools`
 * (design §S.1: an unattended run can never reach an approval prompt, and
 * run_command/eval_js are never in the read-only set). It runs against the
 * active workspace (or none), and never touches the live conversation state.
 *
 * Write-capable automations (which would need worktree isolation + the unified
 * approval queue) are a deliberate follow-on, so this stays unattended-safe.
 */

/** Bounded step budget for one automation run. */
const AUTOMATION_MAX_STEPS = 12;
const MAX_SUMMARY = 2_000;

/**
 * Build the production runner, given an accessor for the currently-active
 * workspace (injected so this stays testable + decoupled from the registry).
 */
export function createAutomationRunner(getWorkspace: () => WorkspaceSummary | null): AutomationRunner {
  return async (automation: Automation): Promise<AutomationRun> => {
    const startedAt = Date.now();
    const fail = (summary: string): AutomationRun => ({
      startedAt,
      finishedAt: Date.now(),
      status: 'error',
      summary: clipText(summary, MAX_SUMMARY),
    });

    if (!isProviderId(automation.provider)) {
      return fail(`unknown provider "${automation.provider}"`);
    }
    if (!automation.model.trim()) {
      return fail('no model configured for this automation');
    }

    const ctx: ToolContext = {
      ws: getWorkspace(),
      signal: new AbortController().signal,
      provider: automation.provider,
      model: automation.model,
    };
    const out = await runChildAgent(
      {
        task: automation.prompt,
        label: automation.name,
        provider: automation.provider,
        model: automation.model,
        maxSteps: AUTOMATION_MAX_STEPS,
      },
      ctx,
      undefined,
      undefined,
      automation.allowTools,
    );
    return {
      startedAt,
      finishedAt: Date.now(),
      status: out.isError ? 'error' : 'done',
      summary: clipText(out.text, MAX_SUMMARY),
    };
  };
}
