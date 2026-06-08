import fs from 'node:fs/promises';
import path from 'node:path';
import { requireWorkspace } from '../ipc/define-handler';
import {
  isWorkflowStepTool,
  type Workflow,
  type WorkflowStep,
} from '../../shared/workflows';

/**
 * Per-workspace storage for cached browser workflows (§3.10) under
 * `.marudesk/workflows/*.json`, mirroring the steering-files convention. All file
 * content is untrusted (a user could hand-edit it), so reads re-validate the
 * shape; the workflow id is a generated slug and is regex-guarded before it ever
 * touches the filesystem, so it can't escape the workflows directory.
 */

const WORKFLOWS_DIR = path.join('.marudesk', 'workflows');
const MAX_WORKFLOWS = 100;
const MAX_STEPS = 200;
const ID_RE = /^wf-[a-z0-9-]+$/;

function dirFor(root: string): string {
  return path.join(root, WORKFLOWS_DIR);
}

function sanitizeSteps(raw: unknown): WorkflowStep[] {
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

function parseWorkflow(raw: unknown): Workflow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) return null;
  if (typeof r.name !== 'string') return null;
  return {
    id: r.id,
    name: r.name,
    startUrl: typeof r.startUrl === 'string' ? r.startUrl : null,
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : 0,
    steps: sanitizeSteps(r.steps),
  };
}

export async function listWorkflows(): Promise<Workflow[]> {
  const root = requireWorkspace().root;
  let names: string[];
  try {
    const entries = await fs.readdir(dirFor(root), { withFileTypes: true });
    names = entries.filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => e.name);
  } catch {
    return [];
  }
  const out: Workflow[] = [];
  for (const name of names.slice(0, MAX_WORKFLOWS)) {
    try {
      const wf = parseWorkflow(JSON.parse(await fs.readFile(path.join(dirFor(root), name), 'utf8')));
      if (wf) out.push(wf);
    } catch {
      // skip an unreadable / malformed file
    }
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

export async function saveWorkflow(input: {
  name: string;
  steps: WorkflowStep[];
  startUrl: string | null;
}): Promise<Workflow> {
  const root = requireWorkspace().root;
  const dir = dirFor(root);
  await fs.mkdir(dir, { recursive: true });
  const id = `wf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const wf: Workflow = {
    id,
    name: input.name.trim().slice(0, 80) || 'Untitled workflow',
    startUrl: input.startUrl,
    createdAt: Date.now(),
    steps: sanitizeSteps(input.steps),
  };
  await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(wf, null, 2), 'utf8');
  return wf;
}

export async function loadWorkflow(id: string): Promise<Workflow | null> {
  if (!ID_RE.test(id)) return null;
  const root = requireWorkspace().root;
  try {
    return parseWorkflow(JSON.parse(await fs.readFile(path.join(dirFor(root), `${id}.json`), 'utf8')));
  } catch {
    return null;
  }
}

export async function deleteWorkflow(id: string): Promise<boolean> {
  if (!ID_RE.test(id)) return false;
  const root = requireWorkspace().root;
  try {
    await fs.unlink(path.join(dirFor(root), `${id}.json`));
    return true;
  } catch {
    return false;
  }
}
