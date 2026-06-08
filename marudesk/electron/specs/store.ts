import fs from 'node:fs/promises';
import path from 'node:path';
import { requireWorkspace } from '../ipc/define-handler';
import { isSpecStatus, type Spec, type SpecInput, type SpecTask } from '../../shared/specs';

/**
 * Per-workspace storage for specs (§3.10) under `.marudesk/specs/*.json`,
 * mirroring the steering-files / workflows convention. File content is untrusted
 * (hand-editable), so reads re-validate the shape; the id is a generated slug,
 * regex-guarded before it touches the filesystem so it can't escape the dir.
 */

const SPECS_DIR = path.join('.marudesk', 'specs');
const MAX_SPECS = 200;
const MAX_TASKS = 200;
const MAX_BODY = 40_000;
const ID_RE = /^spec-[a-z0-9-]+$/;

function dirFor(root: string): string {
  return path.join(root, SPECS_DIR);
}

function sanitizeTasks(raw: unknown): SpecTask[] {
  if (!Array.isArray(raw)) return [];
  const out: SpecTask[] = [];
  for (const tRaw of raw.slice(0, MAX_TASKS)) {
    if (!tRaw || typeof tRaw !== 'object') continue;
    const r = tRaw as Record<string, unknown>;
    const text = typeof r.text === 'string' ? r.text.slice(0, 500) : '';
    if (!text.trim()) continue;
    out.push({
      id: typeof r.id === 'string' && r.id ? r.id : `task-${out.length}-${Math.random().toString(36).slice(2, 8)}`,
      text,
      done: r.done === true,
    });
  }
  return out;
}

function parseSpec(raw: unknown): Spec | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) return null;
  return {
    id: r.id,
    title: typeof r.title === 'string' ? r.title.slice(0, 200) : 'Untitled spec',
    body: typeof r.body === 'string' ? r.body.slice(0, MAX_BODY) : '',
    status: isSpecStatus(r.status) ? r.status : 'draft',
    tasks: sanitizeTasks(r.tasks),
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : 0,
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0,
  };
}

export async function listSpecs(): Promise<Spec[]> {
  const root = requireWorkspace().root;
  let names: string[];
  try {
    const entries = await fs.readdir(dirFor(root), { withFileTypes: true });
    names = entries.filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => e.name);
  } catch {
    return [];
  }
  const out: Spec[] = [];
  for (const name of names.slice(0, MAX_SPECS)) {
    try {
      const spec = parseSpec(JSON.parse(await fs.readFile(path.join(dirFor(root), name), 'utf8')));
      if (spec) out.push(spec);
    } catch {
      // skip an unreadable / malformed file
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

export async function saveSpec(input: SpecInput): Promise<Spec> {
  const root = requireWorkspace().root;
  const dir = dirFor(root);
  await fs.mkdir(dir, { recursive: true });
  const now = Date.now();
  const id = input.id && ID_RE.test(input.id) ? input.id : `spec-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  // Preserve createdAt on update.
  let createdAt = now;
  if (input.id) {
    const existing = await loadSpec(input.id);
    if (existing) createdAt = existing.createdAt;
  }
  const spec: Spec = {
    id,
    title: input.title.trim().slice(0, 200) || 'Untitled spec',
    body: typeof input.body === 'string' ? input.body.slice(0, MAX_BODY) : '',
    status: isSpecStatus(input.status) ? input.status : 'draft',
    tasks: sanitizeTasks(input.tasks),
    createdAt,
    updatedAt: now,
  };
  await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(spec, null, 2), 'utf8');
  return spec;
}

export async function loadSpec(id: string): Promise<Spec | null> {
  if (!ID_RE.test(id)) return null;
  const root = requireWorkspace().root;
  try {
    return parseSpec(JSON.parse(await fs.readFile(path.join(dirFor(root), `${id}.json`), 'utf8')));
  } catch {
    return null;
  }
}

export async function deleteSpec(id: string): Promise<boolean> {
  if (!ID_RE.test(id)) return false;
  const root = requireWorkspace().root;
  try {
    await fs.unlink(path.join(dirFor(root), `${id}.json`));
    return true;
  } catch {
    return false;
  }
}
