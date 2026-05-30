import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  isPatchOpArray,
  type ApplyError,
  type ApplyOutcome,
  type ApplyResult,
  type PatchOp,
  type PatchOpPreview,
  type PatchPreview,
} from '../shared/patch';
import type { WorkspaceSummary } from '../shared/workspace';
import { isInsideRoot, resolveWorkspacePath } from './fs-safe';
import { defineHandler, requireWorkspace } from './ipc/define-handler';

const MAX_PATCH_FILE_SIZE = 4 * 1024 * 1024;

// Unpredictable sibling temp name for the multi-file write. patch deliberately
// does NOT use fs-safe.atomicWriteFile: it needs a 3-phase batch (write all
// tmps → rename all → roll back on any failure) for all-or-nothing semantics
// across files, which a single-file helper can't express. The exclusive 'wx'
// open in Phase 2 still gives the same per-file symlink safety.
function pendingTmpPath(abs: string): string {
  return `${abs}.marudesk-tmp-${randomBytes(6).toString('hex')}`;
}

async function readForPatch(absPath: string): Promise<string> {
  const st = await fs.stat(absPath);
  if (st.size > MAX_PATCH_FILE_SIZE) {
    throw new Error(
      `file too large for patch: ${st.size} bytes (limit ${MAX_PATCH_FILE_SIZE})`,
    );
  }
  return fs.readFile(absPath, 'utf8');
}

async function classifyOp(root: string, op: PatchOp): Promise<PatchOpPreview> {
  let abs: string;
  try {
    ({ abs } = resolveWorkspacePath(root, op.path));
  } catch (err) {
    return { kind: 'error', path: op.path, reason: (err as Error).message };
  }

  let exists = true;
  let lst: Awaited<ReturnType<typeof fs.lstat>> | null = null;
  try {
    lst = await fs.lstat(abs);
  } catch {
    exists = false;
  }

  if (exists && lst && lst.isSymbolicLink()) {
    return {
      kind: 'error',
      path: op.path,
      reason: 'refuses to follow symlink',
    };
  }
  if (exists && lst && !lst.isFile()) {
    return {
      kind: 'error',
      path: op.path,
      reason: 'path exists but is not a regular file',
    };
  }

  if (!exists) {
    if (op.oldString.length > 0) {
      return {
        kind: 'error',
        path: op.path,
        reason: 'file does not exist; oldString must be empty to create',
      };
    }
    if (op.newString.length === 0) {
      return {
        kind: 'error',
        path: op.path,
        reason: 'nothing to create (newString is empty)',
      };
    }
    return { kind: 'create', path: op.path, newString: op.newString };
  }

  // File exists. Verify realpath stays inside workspace.
  try {
    const real = await fs.realpath(abs);
    if (!isInsideRoot(root, real)) {
      return {
        kind: 'error',
        path: op.path,
        reason: 'symlink resolves outside workspace',
      };
    }
  } catch (err) {
    return { kind: 'error', path: op.path, reason: (err as Error).message };
  }

  if (op.oldString.length === 0) {
    return {
      kind: 'error',
      path: op.path,
      reason: 'file already exists; oldString must be non-empty for edit',
    };
  }
  if (op.oldString === op.newString) {
    return {
      kind: 'error',
      path: op.path,
      reason: 'oldString and newString are identical',
    };
  }

  let content: string;
  try {
    content = await readForPatch(abs);
  } catch (err) {
    return { kind: 'error', path: op.path, reason: (err as Error).message };
  }

  const first = content.indexOf(op.oldString);
  if (first < 0) {
    return {
      kind: 'error',
      path: op.path,
      reason: 'oldString not found in file',
    };
  }
  const second = content.indexOf(op.oldString, first + op.oldString.length);
  if (second >= 0) {
    return {
      kind: 'error',
      path: op.path,
      reason: 'oldString matches multiple locations; must be unique',
    };
  }

  const startLine = content.slice(0, first).split('\n').length;

  return {
    kind: 'edit',
    path: op.path,
    startLine,
    oldString: op.oldString,
    newString: op.newString,
  };
}

async function buildPreview(
  root: string,
  ops: PatchOp[],
): Promise<PatchPreview> {
  const previews: PatchOpPreview[] = [];
  let hasErrors = false;
  for (const op of ops) {
    const p = await classifyOp(root, op);
    if (p.kind === 'error') hasErrors = true;
    previews.push(p);
  }
  return { ops: previews, hasErrors };
}

type Plan = {
  kind: 'edit' | 'create';
  op: PatchOp;
  abs: string;
  tmp: string;
  nextContent: string;
  originalContent: string | null;
};

async function applyPatch(
  ws: WorkspaceSummary,
  ops: PatchOp[],
): Promise<ApplyResult> {
  const root = ws.root;

  // Phase 1: classify + plan against current disk state.
  const plans: Plan[] = [];
  const planErrors: ApplyError[] = [];

  for (const op of ops) {
    const preview = await classifyOp(root, op);
    if (preview.kind === 'error') {
      planErrors.push({ path: op.path, reason: preview.reason });
      continue;
    }
    let resolved: { rel: string; abs: string };
    try {
      resolved = resolveWorkspacePath(root, op.path);
    } catch (err) {
      planErrors.push({ path: op.path, reason: (err as Error).message });
      continue;
    }
    if (preview.kind === 'create') {
      plans.push({
        kind: 'create',
        op,
        abs: resolved.abs,
        tmp: pendingTmpPath(resolved.abs),
        nextContent: op.newString,
        originalContent: null,
      });
    } else {
      let content: string;
      try {
        content = await readForPatch(resolved.abs);
      } catch (err) {
        planErrors.push({ path: op.path, reason: (err as Error).message });
        continue;
      }
      const idx = content.indexOf(op.oldString);
      const second = content.indexOf(op.oldString, idx + op.oldString.length);
      if (idx < 0 || second >= 0) {
        planErrors.push({
          path: op.path,
          reason: 'oldString match changed between preview and apply',
        });
        continue;
      }
      const nextContent =
        content.slice(0, idx) +
        op.newString +
        content.slice(idx + op.oldString.length);
      plans.push({
        kind: 'edit',
        op,
        abs: resolved.abs,
        tmp: pendingTmpPath(resolved.abs),
        nextContent,
        originalContent: content,
      });
    }
  }

  if (planErrors.length > 0) {
    return { ok: false, applied: [], errors: planErrors };
  }

  // Phase 2: write all pending tmp files. Exclusive-create ('wx') fails if
  // anything already exists at the tmp path, so a symlink pre-planted there
  // can't redirect the write outside the workspace; the rename in Phase 3 is
  // symlink-safe (it replaces a link in place rather than following it).
  const writtenTmps: string[] = [];
  try {
    for (const plan of plans) {
      if (plan.kind === 'create') {
        await fs.mkdir(path.dirname(plan.abs), { recursive: true });
      }
      const fh = await fs.open(plan.tmp, 'wx');
      try {
        await fh.writeFile(plan.nextContent, 'utf8');
      } finally {
        await fh.close();
      }
      writtenTmps.push(plan.tmp);
    }
  } catch (err) {
    for (const tmp of writtenTmps) {
      await fs.unlink(tmp).catch(() => undefined);
    }
    return {
      ok: false,
      applied: [],
      errors: [{ path: '(write phase)', reason: (err as Error).message }],
    };
  }

  // Phase 3: rename sweep with rollback on first failure.
  const applied: ApplyOutcome[] = [];
  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i];
    const tmp = plan.tmp;
    try {
      await fs.rename(tmp, plan.abs);
      applied.push({ path: plan.op.path, kind: plan.kind });
    } catch (err) {
      const reason = `rename failed: ${(err as Error).message}`;
      // Roll back previously committed plans.
      for (let j = i - 1; j >= 0; j--) {
        const earlier = plans[j];
        try {
          if (earlier.kind === 'create') {
            await fs.unlink(earlier.abs);
          } else if (earlier.originalContent !== null) {
            await fs.writeFile(earlier.abs, earlier.originalContent, 'utf8');
          }
        } catch {
          // best-effort
        }
      }
      // Clean up remaining tmps including the one that failed.
      await fs.unlink(tmp).catch(() => undefined);
      for (let k = i + 1; k < plans.length; k++) {
        await fs.unlink(plans[k].tmp).catch(() => undefined);
      }
      return { ok: false, applied: [], errors: [{ path: plan.op.path, reason }] };
    }
  }

  return { ok: true, applied, errors: [] };
}

export function registerPatchHandlers(): void {
  defineHandler('patch:preview', ([payload]) => {
    if (!isPatchOpArray(payload)) {
      throw new Error('payload must be an array of {path, oldString, newString}');
    }
    return buildPreview(requireWorkspace().root, payload);
  });

  defineHandler('patch:apply', ([payload]) => {
    if (!isPatchOpArray(payload)) {
      throw new Error('payload must be an array of {path, oldString, newString}');
    }
    return applyPatch(requireWorkspace().ws, payload);
  });
}
