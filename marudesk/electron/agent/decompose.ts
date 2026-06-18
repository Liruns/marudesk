import { generateText } from 'ai';
import { defineHandler } from '../ipc/define-handler';
import { parseWorkGraph, type WorkGraph } from '../../shared/work-os';
import { buildModel, humanizeModelError } from './model';
import { resolveProviderAuth } from './resolve-auth';
import { resolveSubagentTarget } from './subagent-resolve';
import { runTask } from './run-task';

/**
 * Goal → Task-graph generator (docs/ai-work-os-roadmap.md §6, the "Phase 1
 * heart"). A new, standalone AI entry point — the loop only ever streamed text.
 *
 * Provider/model resolve through {@link resolveSubagentTarget} (the same ranked,
 * connectivity-probed chain subagents use), so it runs on whatever the user has
 * connected without a bespoke picker. The model returns a `WorkGraph` JSON which
 * {@link parseWorkGraph} validates defensively (dropping dangling edges,
 * rejecting cyclic/empty graphs) — the model is never trusted directly. Any
 * failure (no provider, auth, bad JSON) returns `{ ok:false }` so the renderer
 * falls back to its deterministic offline sample.
 *
 * (generateText + JSON extraction, not the SDK's `generateObject`: it's portable
 * across every provider in the catalog, and parseWorkGraph is the real schema
 * gate either way. Swapping in `generateObject` is a later hardening.)
 */

const DECOMPOSE_SYSTEM = `You are a planning assistant for a software work tool. Given a GOAL, break it into a small directed task graph the user can supervise and run.

Reply with ONLY a JSON object (no markdown fence, no prose) of this exact shape:
{
  "goal": string,
  "tasks": [
    {
      "id": string,                // short stable slug, unique
      "title": string,             // task-centric, e.g. "Implement the orders endpoint"
      "intent": string,            // one line: why this task exists
      "kind": "work" | "decision", // "decision" = a human approval gate
      "executor": { "type": "agent", "ref": "agent" },
      "acceptance": [ { "id": string, "text": string, "verdict": "unknown" } ]
    }
  ],
  "edges": [
    { "from": <task id>, "to": <task id>, "type": "depends_on" }
  ]
}

Rules:
- 3 to 7 tasks. Prefer parallelizable work: independent tasks have no edge between them.
- "depends_on" edges point from an upstream task to the downstream task that needs it. NO cycles.
- Each task gets 1-3 concrete, checkable acceptance criteria (e.g. "npm run typecheck passes", "endpoint returns 200", "no console errors").
- All acceptance verdicts start as "unknown".`;

/** Extract the first balanced JSON object from a model reply (tolerates fences/prose). */
function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export async function decomposeGoal(
  goal: string,
): Promise<{ ok: true; graph: WorkGraph } | { ok: false; reason: string }> {
  const trimmed = goal.trim();
  if (!trimmed) return { ok: false, reason: 'Enter a goal first.' };

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

  const resolved = await resolveProviderAuth(target.provider);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };

  try {
    const res = await generateText({
      model: buildModel(target.provider, target.model, resolved.auth, resolved.baseUrl),
      system: DECOMPOSE_SYSTEM,
      prompt: `GOAL:\n${trimmed}`,
      maxOutputTokens: 2048,
    });
    const graph = parseWorkGraph(extractJsonObject(res.text));
    if (!graph) return { ok: false, reason: 'The model did not return a valid task graph.' };
    return { ok: true, graph: { ...graph, goal: trimmed } };
  } catch (err) {
    return { ok: false, reason: humanizeModelError(err, target.provider, target.model) };
  }
}

export function registerWorkOsHandlers(): void {
  defineHandler('workos:decompose', async ([goal]) => decomposeGoal(typeof goal === 'string' ? goal : ''));
  defineHandler('workos:run-task', async ([input]) => runTask(input));
}
