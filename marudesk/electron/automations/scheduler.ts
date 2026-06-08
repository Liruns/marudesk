import type { Automation, AutomationRun } from '../../shared/automations';
import { dueAutomations, recordRun } from './store';

/**
 * Automation scheduler (Stage 12-C). A periodic tick finds the automations whose
 * `nextRunAt` has passed and runs each (at most once concurrently), then records
 * the outcome + advances the schedule. The "find due → run → record" core is
 * injected with a runner so it's headless-testable without a real agent; the live
 * scheduler just wraps it in a setInterval driven from main.
 */

/** Runs one automation to completion, returning its recorded outcome. */
export type AutomationRunner = (automation: Automation) => Promise<AutomationRun>;

/** Automations with a run currently in flight — so a slow run isn't double-fired. */
const running = new Set<string>();

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Run every automation due at `now` via `runOne`, recording each outcome and
 * advancing its schedule. Skips any automation already running. Returns the ids
 * actually started this tick. An individual run's failure is captured as an
 * `error` AutomationRun — one bad automation never wedges the tick.
 */
export async function runDueAutomations(
  now: number,
  runOne: AutomationRunner,
): Promise<string[]> {
  const due = dueAutomations(now).filter((a) => !running.has(a.id));
  const started: string[] = [];
  await Promise.all(
    due.map(async (automation) => {
      running.add(automation.id);
      started.push(automation.id);
      try {
        let run: AutomationRun;
        try {
          run = await runOne(automation);
        } catch (err) {
          run = {
            startedAt: now,
            finishedAt: Date.now(),
            status: 'error',
            summary: (err as Error).message,
          };
        }
        // Advance nextRunAt (in recordRun) BEFORE leaving the in-flight set, so a
        // tick landing between the run finishing and the schedule advancing can't
        // re-select a still-past-due automation and double-fire it.
        await recordRun(automation.id, run, Date.now());
      } finally {
        running.delete(automation.id);
      }
    }),
  );
  return started;
}

/** Run a single automation immediately (Settings "Run now"), bypassing the schedule. */
export async function runAutomationNow(
  automation: Automation,
  runOne: AutomationRunner,
): Promise<AutomationRun> {
  if (running.has(automation.id)) {
    return { startedAt: Date.now(), finishedAt: Date.now(), status: 'error', summary: 'already running' };
  }
  running.add(automation.id);
  let run: AutomationRun;
  try {
    run = await runOne(automation);
  } catch (err) {
    run = { startedAt: Date.now(), finishedAt: Date.now(), status: 'error', summary: (err as Error).message };
  } finally {
    running.delete(automation.id);
  }
  // advanceSchedule=false: a manual run records the outcome but doesn't delay the
  // next scheduled fire.
  await recordRun(automation.id, run, Date.now(), false);
  return run;
}

/** Start the periodic tick (idempotent). `intervalMs` defaults to one minute. */
export function startScheduler(runOne: AutomationRunner, intervalMs = 60_000): void {
  if (timer) return;
  timer = setInterval(() => {
    void runDueAutomations(Date.now(), runOne);
  }, intervalMs);
  // Don't hold the process open just for the scheduler.
  if (typeof timer.unref === 'function') timer.unref();
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Test-only: clear the in-flight set + timer. */
export function __resetSchedulerForTests(): void {
  running.clear();
  stopScheduler();
}
