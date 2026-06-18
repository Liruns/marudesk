import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { clipText } from '../../shared/text-clip';
import { randomId } from '../../shared/id';
import { resolveWorkspacePath } from '../fs-safe';
import type { ImplementTaskResult, Resource, RunTaskInput, RunTaskResult } from '../../shared/work-os';
import type { WorkspaceSummary } from '../../shared/workspace';
import { getCurrentWorkspace } from '../workspace';
import { getSettingsSync } from '../settings';
import { runGit } from '../git';
import {
  agentBranchName,
  createWorktree,
  discardWorktree,
  isGitRepo,
  worktreeChanges,
} from '../git-worktree';
import { resolveProviderAuth } from './resolve-auth';
import { resolveSubagentTarget } from './subagent-resolve';
import { runChildAgent } from './subagent-runtime';
import type { ToolContext } from './tools/types';

/**
 * Run ONE Work-OS task as a real agent (docs/ai-work-os-roadmap.md §5 — the
 * "execute" step of the Phase-1 loop). This is the honest replacement for the
 * dry-run simulator: a node now spawns an actual agent against the active
 * workspace instead of stamping a fake verdict.
 *
 * Reuses {@link runChildAgent} — the same READ-ONLY child toolset background
 * agents and automations use (no write/gated tools, so an unattended node run can
 * never reach an approval prompt). Provider/model resolve through the same ranked,
 * connectivity-probed chain subagents use, with mid-run fail-over. Write-capable
 * task execution (worktree + approval queue) is a deliberate later slice, so for
 * now a node *analyses* the workspace and reports against its acceptance criteria
 * rather than editing files.
 *
 * Acceptance verdicts are intentionally NOT decided here from the agent's own
 * claim (that would be the trust-theatre §4 forbids) — the result text is stored
 * as evidence, and system-verified per-criterion verdicts are the next slice.
 */

const MAX_TASK_STEPS = 10;
const MAX_IMPLEMENT_STEPS = 14;
const MAX_RESULT_CHARS = 8_000;
const MAX_PATCH_CHARS = 20_000;
const MAX_OUTPUTS = 8;
const RESOLVE_TIMEOUT_MS = 4_000;
const RUN_TIMEOUT_MS = 180_000;

/** Bounded wait so provider resolution can't hang a run when nothing is connected. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  p.catch(() => undefined); // the race loser must not surface as an unhandledRejection
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Resolve the provider/model target + auth both runTask and implementTask need,
 * with the same bounded waits and "nothing connected" copy. Shared so the two
 * entry points can't drift.
 */
async function resolveTaskTarget(): Promise<
  | { ok: true; target: Awaited<ReturnType<typeof resolveSubagentTarget>> }
  | { ok: false; reason: string }
> {
  let target: Awaited<ReturnType<typeof resolveSubagentTarget>>;
  try {
    target = await withTimeout(
      resolveSubagentTarget({ explicit: { provider: null, model: null }, tierHint: 'smart', agent: null, parent: null }),
      RESOLVE_TIMEOUT_MS,
      'provider resolution',
    );
  } catch {
    return { ok: false, reason: 'No AI provider is connected — add one in Settings.' };
  }
  const auth = await withTimeout(resolveProviderAuth(target.provider), RESOLVE_TIMEOUT_MS, 'provider auth').catch(
    () => ({ ok: false as const, reason: 'No AI provider is connected — add one in Settings.' }),
  );
  if (!auth.ok) return { ok: false, reason: auth.reason };
  return { ok: true, target };
}

/** The first balanced JSON object in a string (tolerates surrounding prose). */
function firstJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const v: unknown = JSON.parse(text.slice(start, i + 1));
          return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Pull a `{ artifacts: [{ path, label? }] }` block from the agent's report. */
function extractArtifacts(text: string): { path: string; label?: string }[] {
  const blocks: string[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (let m = fence.exec(text); m !== null; m = fence.exec(text)) blocks.push(m[1]);
  blocks.push(text); // fallback: scan the whole report
  for (const block of blocks) {
    const obj = firstJsonObject(block);
    const arr = obj && Array.isArray(obj.artifacts) ? obj.artifacts : null;
    if (!arr) continue;
    const out: { path: string; label?: string }[] = [];
    for (const item of arr) {
      if (typeof item !== 'object' || item === null) continue;
      const r = item as Record<string, unknown>;
      if (typeof r.path !== 'string' || !r.path.trim()) continue;
      out.push({ path: r.path.trim(), ...(typeof r.label === 'string' ? { label: r.label } : {}) });
    }
    if (out.length > 0) return out;
  }
  return [];
}

/** Resolve reported artifacts to real, existing files INSIDE the workspace root. */
function resolveOutputs(root: string | null, artifacts: { path: string; label?: string }[]): Resource[] {
  if (!root) return [];
  const out: Resource[] = [];
  const seen = new Set<string>();
  for (const a of artifacts) {
    if (out.length >= MAX_OUTPUTS) break;
    let abs: string;
    try {
      ({ abs } = resolveWorkspacePath(root, a.path));
    } catch {
      continue;
    }
    if (seen.has(abs)) continue;
    try {
      const lst = fs.lstatSync(abs);
      if (lst.isSymbolicLink() || !lst.isFile()) continue;
      const realRel = path.relative(root, fs.realpathSync(abs));
      if (realRel.startsWith('..') || path.isAbsolute(realRel)) continue;
    } catch {
      continue;
    }
    seen.add(abs);
    out.push({ id: randomId('res'), kind: 'code', uri: pathToFileURL(abs).href, label: a.label ?? a.path });
  }
  return out;
}

/** Drop fenced ```json artifact blocks from the human-readable result text. */
function stripJsonFences(text: string): string {
  return text.replace(/```json[\s\S]*?```/gi, '').trim();
}

/** Defensively validate the IPC payload (args arrive as `unknown`). */
function parseInput(raw: unknown): RunTaskInput | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.taskId !== 'string' || typeof r.title !== 'string') return null;
  return {
    taskId: r.taskId,
    title: r.title,
    intent: typeof r.intent === 'string' ? r.intent : '',
    goal: typeof r.goal === 'string' ? r.goal : '',
    acceptance: Array.isArray(r.acceptance)
      ? r.acceptance.filter((x): x is string => typeof x === 'string')
      : [],
  };
}

function seedPrompt(input: RunTaskInput): string {
  const goal = input.goal.trim() ? `\n\nThe task belongs to this overall goal: ${input.goal.trim()}` : '';
  const criteria =
    input.acceptance.length > 0
      ? `\n\nAcceptance criteria you are being judged against — address each:\n${input.acceptance
          .map((c, i) => `${i + 1}. ${c}`)
          .join('\n')}`
      : '';
  return `You are executing ONE task in a larger plan. Use your read-only tools (read files, search the workspace, inspect) to do the analysis this task needs, then report concisely: what you found or did, and for each acceptance criterion whether it appears met and why.

Task: ${input.title.trim() || '(untitled)'}
Intent: ${input.intent.trim() || '(none given)'}${goal}${criteria}

At the very end of your report, on its own line, emit a fenced \`\`\`json block listing the key workspace files this task relates to so the user can open them — only REAL files you actually inspected, as workspace-relative paths. Shape (replace the placeholders with real paths; do not echo them verbatim):
\`\`\`json
{"artifacts":[{"path":"<workspace-relative path>","label":"<why it matters>"}]}
\`\`\``;
}

export async function runTask(raw: unknown): Promise<RunTaskResult> {
  const input = parseInput(raw);
  if (!input) return { ok: false, reason: 'Invalid task payload.' };
  if (!input.title.trim() && !input.intent.trim()) {
    return { ok: false, reason: 'This task has no title or intent to act on.' };
  }

  const resolved = await resolveTaskTarget();
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  const { target } = resolved;

  const ac = new AbortController();
  const ctx: ToolContext = {
    ws: getCurrentWorkspace(),
    signal: ac.signal,
    provider: target.provider,
    model: target.model,
  };

  const timer = setTimeout(() => ac.abort(), RUN_TIMEOUT_MS);
  let out: Awaited<ReturnType<typeof runChildAgent>>;
  try {
    out = await runChildAgent(
      {
        task: seedPrompt(input),
        label: input.title.trim() || 'Task',
        provider: target.provider,
        model: target.model,
        maxSteps: MAX_TASK_STEPS,
        fallbacks: target.fallbacks,
      },
      ctx,
    );
  } finally {
    clearTimeout(timer);
  }

  const outputs = out.isError ? [] : resolveOutputs(ctx.ws?.root ?? null, extractArtifacts(out.text));
  return {
    ok: true,
    status: out.isError ? 'failed' : 'done',
    result: clipText(stripJsonFences(out.text) || out.text, MAX_RESULT_CHARS),
    outputs,
  };
}

function implementPrompt(input: RunTaskInput): string {
  const goal = input.goal.trim() ? `\n\nOverall goal: ${input.goal.trim()}` : '';
  const criteria =
    input.acceptance.length > 0
      ? `\n\nAcceptance criteria — satisfy each:\n${input.acceptance.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
      : '';
  return `You are implementing ONE task in a larger plan. You are working in an ISOLATED git worktree (a throwaway copy of the repo) — make the real edits this task needs with edit_file / multi_edit. Nothing you change touches the user's live files: the diff is captured for the user to review and apply deliberately. Read a file before you edit it; keep the change minimal and focused on THIS task only. When done, briefly summarize what you changed and why.

Task: ${input.title.trim() || '(untitled)'}
Intent: ${input.intent.trim() || '(none given)'}${goal}${criteria}`;
}

/**
 * Run ONE task WRITE-capable in an isolated git worktree, capture the diff, then
 * discard the worktree (docs/ai-work-os-roadmap.md §5 — write-back, isolated). The
 * live workspace is never modified: edits land in a throwaway `marudesk/agent/*`
 * worktree, the unified diff is returned for the user to review, and the worktree
 * + branch are dropped. Reuses {@link runChildAgent} with file-write tools enabled
 * (still no `run_command`/`eval_js`) so an unattended run can't run shell commands
 * even inside the worktree.
 */
export async function implementTask(raw: unknown): Promise<ImplementTaskResult> {
  const input = parseInput(raw);
  if (!input) return { ok: false, reason: 'Invalid task payload.' };
  if (!input.title.trim() && !input.intent.trim()) {
    return { ok: false, reason: 'This task has no title or intent to act on.' };
  }

  const ws = getCurrentWorkspace();
  if (!ws) return { ok: false, reason: 'Open a workspace folder first.' };
  if (!(await isGitRepo(ws.root))) {
    return { ok: false, reason: 'Implement needs a local git repository (it edits in an isolated worktree).' };
  }

  const resolved = await resolveTaskTarget();
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  const { target } = resolved;

  const branch = agentBranchName();
  // A fresh, unique parent per run so two concurrent implements never collide on
  // the worktree directory (the branch name is timestamp-based, also unique).
  const worktreePath = path.join(os.tmpdir(), 'marudesk-workos', `${randomId('wt')}`, 'tree');
  try {
    await createWorktree(ws.root, worktreePath, branch);
  } catch (err) {
    // `git worktree add` may have partially succeeded before the post-add check
    // threw — clean up so we never leak a dangling worktree/branch.
    await discardWorktree(ws.root, worktreePath, branch).catch(() => undefined);
    return { ok: false, reason: `Could not create an isolated worktree: ${(err as Error).message}` };
  }

  try {
    // The child writes against the WORKTREE root (edit_file/multi_edit resolve
    // paths off ctx.ws.root), so every edit is contained there, not in the repo.
    // Carry the user's never-edit globs so the write agent still can't touch
    // protected/secret files even inside the isolated copy.
    const worktreeWs: WorkspaceSummary = { ...ws, root: worktreePath };
    const ac = new AbortController();
    const ctx: ToolContext = {
      ws: worktreeWs,
      signal: ac.signal,
      provider: target.provider,
      model: target.model,
      denyGlobs: getSettingsSync().agent.denyGlobs,
    };
    const timer = setTimeout(() => ac.abort(), RUN_TIMEOUT_MS);
    let out: Awaited<ReturnType<typeof runChildAgent>>;
    try {
      out = await runChildAgent(
        {
          task: implementPrompt(input),
          label: input.title.trim() || 'Task',
          provider: target.provider,
          model: target.model,
          maxSteps: MAX_IMPLEMENT_STEPS,
          fallbacks: target.fallbacks,
        },
        ctx,
        undefined,
        undefined,
        undefined,
        { write: true },
      );
    } finally {
      clearTimeout(timer);
    }

    let patch = '';
    let changedFiles: string[] = [];
    try {
      await runGit(worktreePath, ['add', '-A']);
      changedFiles = (await worktreeChanges(worktreePath)).files;
    } catch {
      // staging/status failed — leave changedFiles empty
    }
    if (changedFiles.length > 0) {
      try {
        patch = (await runGit(worktreePath, ['diff', '--cached'])).stdout;
      } catch {
        patch = '(diff unavailable — the change set was too large to capture)';
      }
    }

    return {
      ok: true,
      status: out.isError ? 'failed' : 'done',
      result: clipText(out.text, MAX_RESULT_CHARS),
      patch: clipText(patch, MAX_PATCH_CHARS),
      changedFiles,
    };
  } finally {
    // Always discard — the live workspace stays untouched whatever happened.
    await discardWorktree(ws.root, worktreePath, branch).catch((err) =>
      console.warn('[workos] worktree discard failed; temp tree may leak at', worktreePath, (err as Error).message),
    );
    await fs.promises.rm(path.dirname(worktreePath), { recursive: true, force: true }).catch(() => undefined);
  }
}
