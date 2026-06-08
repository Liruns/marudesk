import { defineHandler } from '../ipc/define-handler';
import { nonEmptyStr, obj } from '../ipc/validate';
import { isSpecStatus, type SpecInput, type SpecTask } from '../../shared/specs';
import { deleteSpec, listSpecs, saveSpec } from './store';

/**
 * IPC surface for the spec lifecycle (§3.10). All payloads are validated before
 * touching the store; the store re-validates file content on read.
 */

function parseTasks(raw: unknown): SpecTask[] {
  if (!Array.isArray(raw)) return [];
  const out: SpecTask[] = [];
  for (const t of raw.slice(0, 200)) {
    if (!t || typeof t !== 'object') continue;
    const r = t as Record<string, unknown>;
    const text = typeof r.text === 'string' ? r.text : '';
    if (!text.trim()) continue;
    out.push({
      id: typeof r.id === 'string' && r.id ? r.id : `task-${out.length}`,
      text,
      done: r.done === true,
    });
  }
  return out;
}

function parseInput(payload: unknown): SpecInput {
  const p = obj(payload);
  return {
    id: typeof p.id === 'string' ? p.id : undefined,
    title: nonEmptyStr(p.title, 'title'),
    body: typeof p.body === 'string' ? p.body : '',
    status: isSpecStatus(p.status) ? p.status : undefined,
    tasks: parseTasks(p.tasks),
  };
}

export function registerSpecHandlers(): void {
  defineHandler('specs:list', () => listSpecs());
  defineHandler('specs:save', ([payload]) => saveSpec(parseInput(payload)));
  defineHandler('specs:delete', ([payload]) => deleteSpec(nonEmptyStr(obj(payload).id, 'id')));
}
