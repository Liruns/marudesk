/**
 * Automations (v6 §G3 / Stage 12-C) — saved prompts that run on a schedule as a
 * detached, read-only agent, so recurring chores (a morning triage, a nightly
 * dependency scan) happen without a human kicking them off. Pure types + the
 * schedule math, shared by the main-process store/scheduler and the Settings UI.
 *
 * Safety (design §S.1): an automation runs UNATTENDED, so it can never reach an
 * approval prompt. It therefore runs on the same read-only, non-gated toolset as
 * a background agent, further narrowed by a per-automation tool allow-list — and
 * `run_command`/`eval_js` are never available. Write-capable automations wait on
 * the unified approval queue (a deliberate non-goal here).
 */

/** How often an automation fires. Kept to a few well-defined shapes (no raw cron). */
export type AutomationSchedule =
  | { kind: 'interval'; everyMinutes: number }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekly'; weekday: number; hour: number; minute: number };

/** The outcome of one automation run, retained for the Settings history. */
export type AutomationRun = {
  startedAt: number;
  finishedAt: number;
  status: 'done' | 'error';
  /** The child's final report (done) or the failure reason (error), clipped. */
  summary: string;
};

/** One saved automation. */
export type Automation = {
  id: string;
  name: string;
  /** The prompt handed to the scheduled agent each run. */
  prompt: string;
  provider: string;
  model: string;
  schedule: AutomationSchedule;
  /** Un-namespaced tool names the run may use (subset of the read-only toolset). Empty = the default read-only set. */
  allowTools: string[];
  enabled: boolean;
  /** Epoch ms of the last run, or null if it never ran. */
  lastRunAt: number | null;
  /** Epoch ms the next run is due, or null when disabled / unscheduled. */
  nextRunAt: number | null;
  /** The most recent run's outcome (for the Settings row), or null. */
  lastRun: AutomationRun | null;
  createdAt: number;
};

/** The editable fields when creating/updating an automation (IPC + store input). */
export type AutomationInput = {
  name: string;
  prompt: string;
  provider: string;
  model: string;
  schedule: AutomationSchedule;
  allowTools: string[];
  enabled: boolean;
};

/** Minimum interval (minutes) — a guard against a runaway tight loop. */
export const MIN_INTERVAL_MINUTES = 5;

/** Clamp + validate a schedule's numeric fields into a safe canonical form. */
export function normalizeSchedule(s: AutomationSchedule): AutomationSchedule {
  if (s.kind === 'interval') {
    return { kind: 'interval', everyMinutes: Math.max(MIN_INTERVAL_MINUTES, Math.floor(s.everyMinutes) || MIN_INTERVAL_MINUTES) };
  }
  if (s.kind === 'daily') {
    return { kind: 'daily', hour: clamp(s.hour, 0, 23), minute: clamp(s.minute, 0, 59) };
  }
  return {
    kind: 'weekly',
    weekday: clamp(s.weekday, 0, 6),
    hour: clamp(s.hour, 0, 23),
    minute: clamp(s.minute, 0, 59),
  };
}

function clamp(n: number, lo: number, hi: number): number {
  const v = Math.floor(n);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
}

/**
 * The next time (epoch ms strictly AFTER `from`) a schedule fires. Interval is
 * relative to `from`; daily/weekly resolve in LOCAL time. Pure — `from` is
 * injected so it's deterministic to test.
 */
export function nextRun(schedule: AutomationSchedule, from: number): number {
  const s = normalizeSchedule(schedule);
  if (s.kind === 'interval') {
    return from + s.everyMinutes * 60_000;
  }
  const d = new Date(from);
  const next = new Date(from);
  next.setHours(s.kind === 'daily' ? s.hour : s.hour, s.minute, 0, 0);
  if (s.kind === 'daily') {
    if (next.getTime() <= from) next.setDate(d.getDate() + 1);
    return next.getTime();
  }
  // weekly: advance to the target weekday at/after `from`.
  let dayDelta = (s.weekday - next.getDay() + 7) % 7;
  if (dayDelta === 0 && next.getTime() <= from) dayDelta = 7;
  next.setDate(d.getDate() + dayDelta);
  return next.getTime();
}

/** Whether an automation is due to run at `now` (enabled + its next run has passed). */
export function isDue(automation: Pick<Automation, 'enabled' | 'nextRunAt'>, now: number): boolean {
  return automation.enabled && automation.nextRunAt !== null && now >= automation.nextRunAt;
}

/** A short, human label for a schedule (Settings rows). */
export function describeSchedule(s: AutomationSchedule): string {
  if (s.kind === 'interval') {
    return s.everyMinutes % 60 === 0 ? `every ${s.everyMinutes / 60}h` : `every ${s.everyMinutes}m`;
  }
  const hhmm = `${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`;
  if (s.kind === 'daily') return `daily ${hhmm}`;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return `${days[s.weekday] ?? '?'} ${hhmm}`;
}
