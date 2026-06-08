import { defineHandler } from '../ipc/define-handler';
import { arr, bool, nonEmptyStr, num, obj, str } from '../ipc/validate';
import type { AutomationInput, AutomationSchedule } from '../../shared/automations';
import {
  createAutomation,
  deleteAutomation,
  listAutomations,
  setAutomationEnabled,
  updateAutomation,
  automationsForTick,
} from './store';
import { runAutomationNow, type AutomationRunner } from './scheduler';

/**
 * IPC for Settings → Automations (Stage 12-C). Every renderer payload is
 * untrusted, so the editable input is validated here (the schedule is coerced to
 * one of the known shapes). "Run now" uses the injected production runner so the
 * scheduled + manual paths share one execution.
 */

function parseSchedule(v: unknown): AutomationSchedule {
  const o = obj(v, 'schedule');
  if (o.kind === 'daily') return { kind: 'daily', hour: num(o.hour, 'hour'), minute: num(o.minute, 'minute') };
  if (o.kind === 'weekly') {
    return { kind: 'weekly', weekday: num(o.weekday, 'weekday'), hour: num(o.hour, 'hour'), minute: num(o.minute, 'minute') };
  }
  return { kind: 'interval', everyMinutes: num(o.everyMinutes, 'everyMinutes') };
}

function parseInput(v: unknown): AutomationInput {
  const o = obj(v, 'automation');
  return {
    name: nonEmptyStr(o.name, 'name'),
    prompt: nonEmptyStr(o.prompt, 'prompt'),
    provider: nonEmptyStr(o.provider, 'provider'),
    model: str(o.model, 'model'),
    schedule: parseSchedule(o.schedule),
    allowTools: arr(o.allowTools ?? [], 'allowTools').filter((t): t is string => typeof t === 'string'),
    enabled: o.enabled === undefined ? true : bool(o.enabled, 'enabled'),
  };
}

/** Register the automation IPC handlers. `runOne` is the production runner. */
export function registerAutomationHandlers(runOne: AutomationRunner): void {
  defineHandler('automations:list', () => listAutomations());

  defineHandler('automations:create', ([input]) => createAutomation(parseInput(input)));

  defineHandler('automations:update', ([payload]) => {
    const p = obj(payload);
    return updateAutomation(nonEmptyStr(p.id, 'id'), parseInput(p.input));
  });

  defineHandler('automations:delete', async ([payload]) => ({
    ok: await deleteAutomation(nonEmptyStr(obj(payload).id, 'id')),
  }));

  defineHandler('automations:set-enabled', ([payload]) => {
    const p = obj(payload);
    return setAutomationEnabled(nonEmptyStr(p.id, 'id'), bool(p.enabled, 'enabled'));
  });

  defineHandler('automations:run-now', ([payload]) => {
    const id = nonEmptyStr(obj(payload).id, 'id');
    const automation = automationsForTick().find((a) => a.id === id);
    if (!automation) return null;
    return runAutomationNow(automation, runOne);
  });
}
