import { generateText } from 'ai';
import type { RunTaskInput, RunTaskResult, TaskVerdict } from '../../shared/work-os';
import { buildModel, humanizeModelError } from './model';
import { resolveProviderAuth } from './resolve-auth';
import { resolveSubagentTarget } from './subagent-resolve';
import { extractJsonObject } from './decompose';

/**
 * Run ONE Work-OS task with the model (docs/ai-work-os-roadmap.md — the real
 * counterpart to the renderer's simulate). The renderer's `runGraph` walks the
 * pure scheduler (shared/work-os.ts) and calls this per ready task, in dependency
 * order and in parallel within a layer, threading each task's upstream `handoff`
 * through `context`. This is the single-task unit: given the task, its goal,
 * acceptance, and that upstream context, the model reports what the task
 * accomplished, the context to hand downstream, and a self-verdict per criterion.
 *
 * Provider/model resolve through {@link resolveSubagentTarget} (the same ranked,
 * connectivity-probed chain subagents + the decomposer use), so it runs on
 * whatever the user has connected. No provider / auth failure returns
 * `{ ok:false, kind:'no-provider' }` so the renderer can fall back to a
 * deterministic offline pass without stranding the run.
 */

const RUN_TASK_SYSTEM = `You are an autonomous worker executing ONE task inside a larger plan, under human supervision. You are given the overall GOAL, the TASK to do (title + intent), its ACCEPTANCE criteria, and CONTEXT handed down from the upstream tasks that already finished. Do the reasoning/work for THIS task only — concise and concrete — then report the outcome.

Reply with ONLY a JSON object (no markdown fence, no prose) of this exact shape:
{
  "result": string,        // 1-3 sentences: what this task produced or decided
  "handoff": string,       // the key context the downstream tasks need from you (what you produced/decided), or "" if none
  "verdicts": [ "pass" | "fail" | "unknown" ]  // one per ACCEPTANCE criterion, in order; "unknown" if you cannot tell
}

Rules:
- Stay within THIS task's scope; do not do downstream tasks' work.
- "handoff" is forward-looking context, not a restatement of the title.
- If a criterion cannot be judged from reasoning alone, use "unknown" rather than guessing "pass".`;

const isStr = (v: unknown): v is string => typeof v === 'string';

function parseVerdicts(raw: unknown, count: number): TaskVerdict[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw
    .slice(0, count)
    .map((v): TaskVerdict => (v === 'pass' || v === 'fail' ? v : 'unknown'));
  return out.length > 0 ? out : undefined;
}

/** Validate the IPC payload (untrusted across the boundary) into a RunTaskInput. */
function parseInput(raw: unknown): RunTaskInput {
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    title: isStr(r.title) ? r.title.trim() : '',
    intent: isStr(r.intent) ? r.intent : '',
    goal: isStr(r.goal) ? r.goal : '',
    acceptance: Array.isArray(r.acceptance) ? r.acceptance.filter(isStr) : [],
    context: isStr(r.context) ? r.context : '',
  };
}

export async function runTask(raw: unknown): Promise<RunTaskResult> {
  const input = parseInput(raw);
  if (!input.title) return { ok: false, kind: 'error', reason: 'The task has no title to run.' };

  let target: Awaited<ReturnType<typeof resolveSubagentTarget>>;
  try {
    target = await resolveSubagentTarget({
      explicit: { provider: null, model: null },
      tierHint: 'smart',
      agent: null,
      parent: null,
    });
  } catch {
    return { ok: false, kind: 'no-provider', reason: 'No AI provider is connected — add one in Settings.' };
  }

  const resolved = await resolveProviderAuth(target.provider);
  if (!resolved.ok) return { ok: false, kind: 'no-provider', reason: resolved.reason };

  const acceptance = input.acceptance;
  const prompt = [
    `GOAL:\n${input.goal || '(none given)'}`,
    `TASK:\n${input.title}${input.intent ? `\n${input.intent}` : ''}`,
    acceptance.length
      ? `ACCEPTANCE CRITERIA:\n${acceptance.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
      : 'ACCEPTANCE CRITERIA:\n(none)',
    `CONTEXT FROM UPSTREAM TASKS:\n${input.context.trim() || '(none — this is a starting task)'}`,
  ].join('\n\n');

  try {
    const res = await generateText({
      model: buildModel(target.provider, target.model, resolved.auth, resolved.baseUrl),
      system: RUN_TASK_SYSTEM,
      prompt,
      maxOutputTokens: 1024,
    });
    const parsed = extractJsonObject(res.text);
    const obj = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
    // Fall back to the raw reply as the result if the model didn't emit clean JSON
    // — the task still ran; we just keep whatever it said.
    const result = obj && isStr(obj.result) ? obj.result.trim() : res.text.trim().slice(0, 2000);
    const handoff = obj && isStr(obj.handoff) && obj.handoff.trim() ? obj.handoff.trim().slice(0, 2000) : undefined;
    const verdicts = obj ? parseVerdicts(obj.verdicts, acceptance.length) : undefined;
    return { ok: true, result: result || 'Done.', ...(handoff ? { handoff } : {}), ...(verdicts ? { verdicts } : {}) };
  } catch (err) {
    return { ok: false, kind: 'error', reason: humanizeModelError(err, target.provider, target.model) };
  }
}
