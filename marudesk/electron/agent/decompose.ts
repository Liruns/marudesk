import { generateText } from 'ai';
import { defineHandler } from '../ipc/define-handler';
import { parseWorkGraph, type WorkGraph } from '../../shared/work-os';
import { isProviderId, type ProviderId } from '../../shared/providers';
import { buildModel, humanizeModelError, isFailoverError } from './model';
import { resolveProviderAuth } from './resolve-auth';
import { resolveSubagentTarget, type SubagentTarget } from './subagent-resolve';
import { runTask, implementTask, applyTaskPatch } from './run-task';
import { scrubText } from '../../shared/scrub';
import { detectRepoCheckFacts } from '../diagnostics/checkers';
import { getActiveCheckers } from '../diagnostics/config';
import { getCurrentWorkspace } from '../workspace';

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

/**
 * Race a promise against a timeout. Provider resolution / auth can stall when
 * nothing is connected (network probes with no fast "not configured" answer);
 * a bounded wait lets the Work OS fall back to its offline sample instead of
 * hanging the Generate button forever.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  p.catch(() => undefined); // the race loser must not surface as an unhandledRejection
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const RESOLVE_TIMEOUT_MS = 4_000;
/**
 * Upper bound on the decompose model call. A connected-but-unresponsive provider
 * (outage, bad gateway) would otherwise freeze the Generate button forever; on
 * timeout the renderer falls back to its offline sample graph. Generous so a
 * legitimately slow model still completes.
 */
const MODEL_TIMEOUT_MS = 30_000;

/** Upper bound on the goal text forwarded to the model — keeps the prompt bounded. */
const MAX_GOAL_CHARS = 8_000;

/**
 * Compact, repo-grounding facts handed to the planner alongside the goal so its
 * acceptance criteria are runnable for THIS workspace — the detected stack(s) and
 * the REAL check command(s) the diagnostics runner would invoke here (so it won't
 * emit "npm run typecheck passes" for a Go/Python repo). Derived from the active
 * checker recipes; both arrays empty = no known checker applies.
 */
export type RepoFacts = {
  workspaceName?: string;
  stacks: string[];
  checkCommands: string[];
};

/**
 * The compact repo-facts block folded into the decompose prompt before the goal,
 * or '' when nothing useful is known. Kept terse on purpose — it grounds the
 * model's acceptance criteria without bloating the prompt. Pure: the caller
 * supplies the facts (so the harness can drive every shape without a workspace).
 */
export function buildRepoFactsBlock(facts: RepoFacts | null): string {
  if (!facts) return '';
  const lines: string[] = [];
  if (facts.workspaceName) lines.push(`Workspace: ${facts.workspaceName}`);
  if (facts.stacks.length > 0) lines.push(`Detected stack: ${facts.stacks.join(', ')}`);
  lines.push(
    facts.checkCommands.length > 0
      ? `The real check command(s) for this repo (use THESE in acceptance criteria, not a guessed one): ${facts.checkCommands.join(' && ')}`
      : 'No automated check command was detected for this repo — do NOT invent one (e.g. "npm run typecheck"); prefer behaviour-level, human-checkable acceptance criteria.',
  );
  if (lines.length === 0) return '';
  return `REPO FACTS (ground your acceptance criteria in these):\n${lines.join('\n')}`;
}

/** Assemble the decompose user prompt: the repo-facts block (when present) then the goal. */
export function buildDecomposePrompt(goal: string, facts: RepoFacts | null): string {
  const block = buildRepoFactsBlock(facts);
  return block ? `${block}\n\nGOAL:\n${goal}` : `GOAL:\n${goal}`;
}

/** Extract the first balanced JSON object from a model reply (tolerates fences/prose). */
export function extractJsonObject(text: string): unknown {
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

/**
 * Cap on how many providers a single decompose call may burn on transient
 * failures before giving up to the offline sample: the primary plus up to two
 * resolved fallbacks. Generous enough to ride out a single provider's blip,
 * bounded so a broad outage doesn't stall the Generate button across the whole
 * chain.
 */
const MAX_DECOMPOSE_ATTEMPTS = 3;

/**
 * The injectable transport seam — overridden by the harness, real SDK
 * otherwise. `generate` is narrowed to the `{ text }` slice this module reads
 * (the real {@link generateText} return is a superset, so it stays assignable)
 * so a test stub need not fabricate a whole `GenerateTextResult`.
 */
type GenerateGraphDeps = {
  resolveAuth: typeof resolveProviderAuth;
  makeModel: typeof buildModel;
  generate: (opts: Parameters<typeof generateText>[0]) => Promise<{ text: string }>;
};

const DEFAULT_GENERATE_DEPS: GenerateGraphDeps = {
  resolveAuth: resolveProviderAuth,
  makeModel: buildModel,
  generate: generateText,
};

/** A single attempt's outcome, so the caller can distinguish "keep trying" from "stop". */
type AttemptOutcome =
  | { kind: 'graph'; graph: WorkGraph }
  | { kind: 'parse' } // model answered, output wasn't a valid graph — do NOT burn fallbacks
  | { kind: 'auth'; reason: string } // provider not connected — skip to the next candidate
  | { kind: 'retriable'; err: unknown } // transient transport/availability — try the next candidate
  | { kind: 'fatal'; err: unknown }; // non-retriable transport error — stop

/**
 * One generate attempt against a concrete provider/model: resolve creds, build
 * the model, call generateText within the time budget, and classify the result.
 * Pure aside from the injected transport, so the harness can drive every branch.
 */
async function attemptGenerate(
  provider: ProviderId,
  model: string,
  goal: string,
  facts: RepoFacts | null,
  deps: GenerateGraphDeps,
): Promise<AttemptOutcome> {
  let resolved: Awaited<ReturnType<typeof resolveProviderAuth>>;
  try {
    resolved = await withTimeout(deps.resolveAuth(provider), RESOLVE_TIMEOUT_MS, 'provider auth');
  } catch {
    // Auth resolution stalling/failing is a connectivity problem, not a model
    // error — treat it like "not connected" and fall through to the next candidate.
    return { kind: 'auth', reason: 'No AI provider is connected — add one in Settings.' };
  }
  if (!resolved.ok) return { kind: 'auth', reason: resolved.reason };

  try {
    const res = await withTimeout(
      deps.generate({
        model: deps.makeModel(provider, model, resolved.auth, resolved.baseUrl),
        system: DECOMPOSE_SYSTEM,
        prompt: buildDecomposePrompt(goal, facts),
        maxOutputTokens: 2048,
      }),
      MODEL_TIMEOUT_MS,
      'decompose',
    );
    const graph = parseWorkGraph(extractJsonObject(res.text));
    // A connected model that answered with unusable output is NOT a transport
    // failure: re-rolling it on another provider is unlikely to help and would
    // burn the fallback budget, so stop here.
    if (!graph) return { kind: 'parse' };
    return { kind: 'graph', graph };
  } catch (err) {
    // A timeout (connected-but-unresponsive) and 429/5xx are both transient and
    // worth trying the next provider for; anything else (4xx, malformed request)
    // is fatal — surface it rather than masking it behind the offline sample.
    if (isFailoverError(err) || isTimeoutError(err)) return { kind: 'retriable', err };
    return { kind: 'fatal', err };
  }
}

/** The {@link withTimeout} race loser surfaces as `Error("<label> timed out")`. */
function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && / timed out$/.test(err.message);
}

/**
 * Walk the resolved candidate chain (primary first, then `target.fallbacks`)
 * trying each connected provider until one returns a graph, capping at
 * {@link MAX_DECOMPOSE_ATTEMPTS} model calls. On a transient failure or a
 * not-connected candidate it advances; on a parse failure or a fatal transport
 * error it stops. Returns `{ ok:false }` (the caller then yields the offline
 * sample) when the whole chain is exhausted.
 *
 * Exported for the headless harness — it injects the transport to drive the
 * fail-over and exhaustion paths without a live provider.
 */
export async function generateGraphWithFailover(
  target: SubagentTarget,
  goal: string,
  facts: RepoFacts | null = null,
  deps: GenerateGraphDeps = DEFAULT_GENERATE_DEPS,
): Promise<{ ok: true; graph: WorkGraph } | { ok: false; reason: string }> {
  const chain: { provider: ProviderId; model: string }[] = [
    { provider: target.provider, model: target.model },
  ];
  const seen = new Set<string>([`${target.provider}::${target.model}`]);
  for (const ref of target.fallbacks) {
    const key = `${ref.provider}::${ref.model}`;
    if (seen.has(key) || !isProviderId(ref.provider)) continue;
    seen.add(key);
    chain.push({ provider: ref.provider, model: ref.model });
  }

  let lastErr: unknown;
  let lastReason: string | null = null;
  const attempts = Math.min(chain.length, MAX_DECOMPOSE_ATTEMPTS);
  for (let i = 0; i < attempts; i += 1) {
    const { provider, model } = chain[i];
    const outcome = await attemptGenerate(provider, model, goal, facts, deps);
    if (outcome.kind === 'graph') return { ok: true, graph: outcome.graph };
    if (outcome.kind === 'parse') {
      return { ok: false, reason: 'The model did not return a valid task graph.' };
    }
    if (outcome.kind === 'fatal') {
      return { ok: false, reason: scrubText(humanizeModelError(outcome.err, provider, model)) };
    }
    // 'auth' (not connected) or 'retriable' (transient): remember and advance.
    if (outcome.kind === 'auth') lastReason = outcome.reason;
    else lastErr = outcome.err;
  }

  const reason =
    lastErr !== undefined
      ? scrubText(humanizeModelError(lastErr, target.provider, target.model))
      : lastReason ?? 'No AI provider is connected — add one in Settings.';
  return { ok: false, reason };
}

/**
 * The active workspace's repo facts (name + detected stack + real check command),
 * or null when no workspace is open. Best-effort: reading the recipe set / disk
 * markers can't throw past here — any failure degrades to null so the planner
 * just sees the bare goal rather than failing the whole decompose.
 */
function collectRepoFacts(): RepoFacts | null {
  try {
    const ws = getCurrentWorkspace();
    if (!ws) return null;
    const { stacks, checkCommands } = detectRepoCheckFacts(ws.root, getActiveCheckers());
    return { workspaceName: ws.name, stacks, checkCommands };
  } catch {
    return null;
  }
}

export async function decomposeGoal(
  goal: string,
): Promise<{ ok: true; graph: WorkGraph } | { ok: false; reason: string }> {
  const trimmed = goal.trim();
  if (!trimmed) return { ok: false, reason: 'Enter a goal first.' };
  if (trimmed.length > MAX_GOAL_CHARS) {
    return { ok: false, reason: 'Goal is too long — shorten it.' };
  }

  let target: Awaited<ReturnType<typeof resolveSubagentTarget>>;
  try {
    target = await withTimeout(
      resolveSubagentTarget({
        explicit: { provider: null, model: null },
        tierHint: 'smart',
        agent: null,
        parent: null,
      }),
      RESOLVE_TIMEOUT_MS,
      'provider resolution',
    );
  } catch {
    return { ok: false, reason: 'No AI provider is connected — add one in Settings.' };
  }

  // Ground the planner in THIS repo: the workspace name + the real check
  // command(s) the diagnostics runner would invoke here, so acceptance criteria
  // are runnable for this stack instead of a guessed `npm run typecheck`. Pure
  // facts (our own data, not repo-controlled prose); best-effort — a missing
  // workspace just yields null and the prompt falls back to the bare goal.
  const facts = collectRepoFacts();

  // Try the primary provider, then fail over through `target.fallbacks` on any
  // transient (timeout / 429 / 5xx / not-connected) blip — the same resilience
  // run-task/implement-task get — before the renderer drops to its offline
  // sample. A malformed model answer or a fatal transport error stops early
  // rather than burning the rest of the chain.
  const result = await generateGraphWithFailover(target, trimmed, facts);
  if (!result.ok) return result;
  return { ok: true, graph: { ...result.graph, goal: trimmed } };
}

export function registerWorkOsHandlers(): void {
  defineHandler('workos:decompose', async ([goal]) => decomposeGoal(typeof goal === 'string' ? goal : ''));
  defineHandler('workos:run-task', async ([input]) => runTask(input));
  defineHandler('workos:implement-task', async ([input]) => implementTask(input));
  defineHandler('workos:apply-patch', async ([input]) => applyTaskPatch(input));
}
