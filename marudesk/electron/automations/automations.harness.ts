import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { check, passedCount } from '../harness-kit';
import {
  describeSchedule,
  isDue,
  MIN_INTERVAL_MINUTES,
  nextRun,
  normalizeSchedule,
} from '../../shared/automations.ts';
import {
  configureAutomationStore,
  createAutomation,
  deleteAutomation,
  dueAutomations,
  listAutomations,
  parseAutomations,
  serializeAutomations,
  setAutomationEnabled,
  updateAutomation,
  __resetAutomationStoreForTests,
} from './store.ts';
import {
  runDueAutomations,
  runAutomationNow,
  __resetSchedulerForTests,
} from './scheduler.ts';
import type { Automation, AutomationRun } from '../../shared/automations.ts';

/**
 * Harness for Stage 12-C automations: the pure schedule math, the persistent
 * store (CRUD + serialize/parse + due selection), and the scheduler's
 * find-due→run→record core with a MOCK runner — all headless. Run via
 * `npm run harness:automations`.
 */

const T0 = 1_700_000_000_000; // a fixed reference "now"

async function main(): Promise<void> {
  /* ── schedule math ────────────────────────────────────────────────────── */
  {
    check('interval: nextRun is from + everyMinutes', nextRun({ kind: 'interval', everyMinutes: 30 }, T0) === T0 + 30 * 60_000);
    check('interval: sub-minimum is clamped up', normalizeSchedule({ kind: 'interval', everyMinutes: 1 }).kind === 'interval' &&
      (normalizeSchedule({ kind: 'interval', everyMinutes: 1 }) as { everyMinutes: number }).everyMinutes === MIN_INTERVAL_MINUTES);
    const daily = nextRun({ kind: 'daily', hour: 9, minute: 0 }, T0);
    check('daily: next run is strictly in the future', daily > T0);
    check('daily: next run is within 24h', daily - T0 <= 24 * 60 * 60_000);
    check('daily: lands on hour:minute (local)', new Date(daily).getHours() === 9 && new Date(daily).getMinutes() === 0);
    const weekly = nextRun({ kind: 'weekly', weekday: (new Date(T0).getDay() + 1) % 7, hour: 8, minute: 30 }, T0);
    check('weekly: next run is in the future + within 8 days', weekly > T0 && weekly - T0 <= 8 * 24 * 60 * 60_000);
    check('isDue: enabled + passed nextRun', isDue({ enabled: true, nextRunAt: T0 }, T0 + 1));
    check('isDue: not due before nextRun', !isDue({ enabled: true, nextRunAt: T0 + 10 }, T0));
    check('isDue: disabled is never due', !isDue({ enabled: false, nextRunAt: T0 }, T0 + 1000));
    check('describeSchedule: hourly interval reads as hours', describeSchedule({ kind: 'interval', everyMinutes: 120 }) === 'every 2h');
  }

  /* ── pure (de)serialization ───────────────────────────────────────────── */
  {
    const a: Automation = {
      id: 'x', name: 'n', prompt: 'p', provider: 'anthropic', model: 'm',
      schedule: { kind: 'interval', everyMinutes: 15 }, allowTools: ['read_file'],
      enabled: true, lastRunAt: null, nextRunAt: T0, lastRun: null, createdAt: T0,
    };
    const round = parseAutomations(JSON.parse(serializeAutomations(new Map([[a.id, a]]))));
    check('serialize/parse round-trips', round.get('x')?.allowTools[0] === 'read_file');
    check('parse drops entries missing required fields', parseAutomations({ items: [{ id: 'a' }, { name: 'b' }] }).size === 0);
    check('parse tolerates a non-object', parseAutomations('nope').size === 0);
  }

  /* ── store CRUD + persistence ─────────────────────────────────────────── */
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'auto-')), 'automations.json');
  try {
    __resetAutomationStoreForTests();
    await configureAutomationStore(file);
    check('store starts empty', listAutomations().length === 0);

    const created = await createAutomation({
      name: 'Morning triage', prompt: 'Summarize new console errors', provider: 'anthropic',
      model: 'claude-sonnet-4-6', schedule: { kind: 'interval', everyMinutes: 30 }, allowTools: [], enabled: true,
    }, T0);
    check('create: returns an automation with an id', !!created.id && created.name === 'Morning triage');
    check('create: an enabled automation gets a nextRunAt', created.nextRunAt === T0 + 30 * 60_000);
    check('create: persisted to disk', parseAutomations(JSON.parse(readFileSync(file, 'utf8'))).has(created.id));

    const updated = await updateAutomation(created.id, {
      name: 'Morning triage', prompt: 'Summarize new console errors', provider: 'anthropic',
      model: 'claude-sonnet-4-6', schedule: { kind: 'interval', everyMinutes: 60 }, allowTools: ['read_file'], enabled: true,
    }, T0);
    check('update: schedule change recomputes nextRunAt', updated?.nextRunAt === T0 + 60 * 60_000);
    check('update: allowTools persisted', updated?.allowTools[0] === 'read_file');

    const disabled = await setAutomationEnabled(created.id, false, T0);
    check('disable: clears nextRunAt', disabled?.enabled === false && disabled?.nextRunAt === null);
    check('disable: not due even far in the future', dueAutomations(T0 + 10 ** 9).length === 0);

    await setAutomationEnabled(created.id, true, T0);
    check('re-enable: due once its interval has elapsed', dueAutomations(T0 + 61 * 60_000).length === 1);

    // Re-load from disk → state survives a "restart".
    __resetAutomationStoreForTests();
    await configureAutomationStore(file);
    check('reload: the automation is restored from disk', listAutomations().length === 1);

    /* ── scheduler: find-due → run (mock) → record ──────────────────────── */
    __resetSchedulerForTests();
    const runs: string[] = [];
    const okRunner = async (a: Automation): Promise<AutomationRun> => {
      runs.push(a.id);
      return { startedAt: Date.now(), finishedAt: Date.now(), status: 'done', summary: `ran ${a.name}` };
    };
    const dueNow = T0 + 61 * 60_000;
    const started = await runDueAutomations(dueNow, okRunner);
    check('scheduler: ran the due automation', started.length === 1 && runs.length === 1);
    check('scheduler: recorded the run outcome', listAutomations()[0]!.lastRun?.status === 'done');
    check('scheduler: advanced nextRunAt past the run', (listAutomations()[0]!.nextRunAt ?? 0) > dueNow);
    const again = await runDueAutomations(dueNow, okRunner);
    check('scheduler: no longer due right after running', again.length === 0);

    // run-now bypasses the schedule AND must not shift the next scheduled fire.
    const beforeNext = listAutomations()[0]!.nextRunAt;
    const manual = await runAutomationNow(listAutomations()[0]!, okRunner);
    check('run-now: executes immediately', manual.status === 'done' && runs.length === 2);
    check('run-now: records the outcome (lastRun set)', listAutomations()[0]!.lastRun?.status === 'done');
    check('run-now: does NOT advance the schedule clock', listAutomations()[0]!.nextRunAt === beforeNext);

    // a throwing runner is recorded as an error, not a crash.
    const errNow = T0 + 10 ** 10;
    // Enable far enough in the past that the 60-min interval's next run is already
    // due at errNow.
    await setAutomationEnabled(listAutomations()[0]!.id, true, errNow - 61 * 60_000);
    const badRunner = async (): Promise<AutomationRun> => { throw new Error('boom'); };
    await runDueAutomations(errNow, badRunner);
    check('scheduler: a throwing run is recorded as error', listAutomations()[0]!.lastRun?.status === 'error');

    check('delete: removes the automation', (await deleteAutomation(listAutomations()[0]!.id)) === true && listAutomations().length === 0);

    console.log(`\nautomations harness: ${passedCount()} assertions passed`);
  } finally {
    rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('automations harness FAILED:', err);
  process.exitCode = 1;
});
