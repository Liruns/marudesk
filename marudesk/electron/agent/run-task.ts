import fs from 'node:fs';
import path from 'node:path';
import { clipText } from '../../shared/text-clip';
import { randomId } from '../../shared/id';
import type { Resource, RunTaskInput, RunTaskResult } from '../../shared/work-os';
import { getCurrentWorkspace } from '../workspace';
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
const MAX_RESULT_CHARS = 8_000;
const MAX_OUTPUTS = 8;

/** A `file://` uri for an absolute path (forward slashes; leading slash on Windows). */
function fileUri(abs: string): string {
  const p = abs.replace(/\\/g, '/');
  return `file://${p.startsWith('/') ? p : `/${p}`}`;
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
    const abs = path.resolve(root, a.path);
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue; // outside the workspace
    if (seen.has(abs)) continue;
    try {
      if (!fs.statSync(abs).isFile()) continue;
    } catch {
      continue; // does not exist
    }
    seen.add(abs);
    out.push({ id: randomId('res'), kind: 'code', uri: fileUri(abs), label: a.label ?? a.path });
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

At the very end of your report, on its own line, emit a fenced \`\`\`json block listing the key workspace files this task relates to so the user can open them — only real files you actually inspected, using workspace-relative paths:
\`\`\`json
{"artifacts":[{"path":"src/example.ts","label":"why it matters"}]}
\`\`\``;
}

export async function runTask(raw: unknown): Promise<RunTaskResult> {
  const input = parseInput(raw);
  if (!input) return { ok: false, reason: 'Invalid task payload.' };
  if (!input.title.trim() && !input.intent.trim()) {
    return { ok: false, reason: 'This task has no title or intent to act on.' };
  }

  let target: Awaited<ReturnType<typeof resolveSubagentTarget>>;
  try {
    target = await resolveSubagentTarget({
      explicit: { provider: null, model: null },
      tierHint: 'smart',
      agent: null,
      parent: null,
    });
  } catch {
    return { ok: false, reason: 'No AI provider is connected — add one in Settings.' };
  }

  const auth = await resolveProviderAuth(target.provider);
  if (!auth.ok) return { ok: false, reason: auth.reason };

  const ctx: ToolContext = {
    ws: getCurrentWorkspace(),
    signal: new AbortController().signal,
    provider: target.provider,
    model: target.model,
  };

  const out = await runChildAgent(
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

  const outputs = out.isError ? [] : resolveOutputs(ctx.ws?.root ?? null, extractArtifacts(out.text));
  return {
    ok: true,
    status: out.isError ? 'failed' : 'done',
    result: clipText(stripJsonFences(out.text) || out.text, MAX_RESULT_CHARS),
    outputs,
  };
}
