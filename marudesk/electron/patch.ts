import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  isPatchOpArray,
  locatePatch,
  type AppliedChange,
  type ApplyError,
  type ApplyOutcome,
  type ApplyResult,
  type PatchOp,
  type PatchOpPreview,
  type PatchPreview,
} from '../shared/patch';
import type { WorkspaceSummary } from '../shared/workspace';
import { assertRealParentInsideRoot, isInsideRoot, resolveWorkspacePath } from './fs-safe';
import { defineHandler, requireWorkspace } from './ipc/define-handler';
import { locateAnchorLine } from './agent/line-anchor';

const MAX_PATCH_FILE_SIZE = 4 * 1024 * 1024;

/** Whether an op carries a hash anchor (v6 §W1 B-layer), vs a verbatim oldString. */
function isAnchored(op: PatchOp): boolean {
  return typeof op.anchor === 'string' && op.anchor.length > 0;
}

/**
 * Locate the `[start, end)` char span an edit op replaces. Anchored ops (B-layer)
 * resolve by the unique line hash — and optionally extend through `endAnchor` for
 * a multi-line span; everything else uses the A-layer verbatim `oldString` path
 * unchanged. Shared by classifyOp (preview) and applyPatch (apply) so the two
 * can't drift. A stale/ambiguous anchor comes back as an error reason.
 */
function resolveEditSpan(
  content: string,
  op: PatchOp,
): { ok: true; start: number; end: number } | { ok: false; reason: string } {
  if (isAnchored(op)) {
    const startSpan = locateAnchorLine(content, op.anchor as string);
    if (!startSpan.ok) {
      return {
        ok: false,
        reason:
          startSpan.reason === 'ambiguous'
            ? 'anchor matches multiple identical lines; use oldString or an endAnchor'
            : 'anchor not found — the file changed since you read it; re-read it for fresh anchors',
      };
    }
    let end = startSpan.end;
    if (typeof op.endAnchor === 'string' && op.endAnchor.length > 0) {
      const endSpan = locateAnchorLine(content, op.endAnchor);
      if (!endSpan.ok) {
        return {
          ok: false,
          reason:
            endSpan.reason === 'ambiguous'
              ? 'endAnchor matches multiple identical lines; not unique'
              : 'endAnchor not found — re-read the file for fresh anchors',
        };
      }
      if (endSpan.end < startSpan.start) {
        return { ok: false, reason: 'endAnchor precedes anchor' };
      }
      end = endSpan.end;
    }
    return { ok: true, start: startSpan.start, end };
  }

  const match = locatePatch(content, op.oldString);
  if (!match.ok) {
    return {
      ok: false,
      reason:
        match.reason === 'ambiguous'
          ? 'oldString matches multiple locations; must be unique'
          : 'oldString not found in file',
    };
  }
  return { ok: true, start: match.start, end: match.end };
}

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
  const buf = await fs.readFile(absPath);
  // A NUL byte in the head marks a binary file (same heuristic as the editor's
  // read guard, workspace.ts). A patch edits by re-encoding the whole decoded
  // string, so reading a binary as lossy UTF-8 and writing it back would corrupt
  // every byte outside the match — refuse it outright rather than mangle the file.
  if (buf.subarray(0, 8192).includes(0)) {
    throw new Error('file appears to be binary; patch only edits text files');
  }
  return buf.toString('utf8');
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
    if (isAnchored(op)) {
      return {
        kind: 'error',
        path: op.path,
        reason: 'cannot anchor-edit a file that does not exist',
      };
    }
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

  // An anchored edit identifies its target by line hash, so oldString may be
  // empty; only the verbatim path requires a non-empty oldString.
  if (!isAnchored(op) && op.oldString.length === 0) {
    return {
      kind: 'error',
      path: op.path,
      reason: 'file already exists; oldString must be non-empty for edit',
    };
  }

  let content: string;
  try {
    content = await readForPatch(abs);
  } catch (err) {
    return { kind: 'error', path: op.path, reason: (err as Error).message };
  }

  const span = resolveEditSpan(content, op);
  if (!span.ok) {
    return { kind: 'error', path: op.path, reason: span.reason };
  }

  // Reject a literal no-op (the spanned text already equals the replacement) so
  // an anchored or verbatim edit that changes nothing surfaces clearly.
  if (content.slice(span.start, span.end) === op.newString) {
    return {
      kind: 'error',
      path: op.path,
      reason: 'the edit would not change the file (replacement equals current text)',
    };
  }

  const startLine = content.slice(0, span.start).split('\n').length;

  return {
    kind: 'edit',
    path: op.path,
    startLine,
    oldString: content.slice(span.start, span.end),
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

export async function applyPatch(
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
      const span = resolveEditSpan(content, op);
      if (!span.ok) {
        planErrors.push({ path: op.path, reason: span.reason });
        continue;
      }
      const nextContent =
        content.slice(0, span.start) + op.newString + content.slice(span.end);
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
        // The 'wx' open below blocks a symlink planted AT the tmp path, but not a
        // symlinked ANCESTOR dir that redirects the write outside the workspace.
        // Confirm the (now-created) parent's realpath stays inside root — same
        // guard the workspace mutate handlers use for create destinations.
        await assertRealParentInsideRoot(root, plan.abs);
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

  // All renames committed: surface each file's before/after so callers (the
  // agent edit history) can diff + revert without re-reading disk.
  const changes: AppliedChange[] = plans.map((p) => ({
    path: p.op.path,
    kind: p.kind,
    before: p.originalContent,
    after: p.nextContent,
  }));
  return { ok: true, applied, errors: [], changes };
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
