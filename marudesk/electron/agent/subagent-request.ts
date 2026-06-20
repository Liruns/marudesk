import type { ProviderId } from '../../shared/providers';
import { isProviderId } from '../../shared/providers';
import { agentCatalogLine, findAgent, listAgents, type AgentDef } from './agents-store';
import { resolveSubagentTarget } from './subagent-resolve';
import type { ToolContext } from './tools/types';
import {
  DEFAULT_CHILD_STEPS,
  MAX_CHILD_STEPS,
  MAX_LABEL_CHARS,
  MAX_TASK_CHARS,
  type SubagentRunRequest,
} from './subagent-types';

export class SubagentInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubagentInputError';
  }
}

export function recordSubagentInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SubagentInputError('spawn_subagent input must be an object.');
  }
  return Object.fromEntries(Object.entries(value));
}

/**
 * Placeholder values a model commonly fills an "optional" provider/model field
 * with when it really means "use the parent's". We treat these as "inherit"
 * instead of rejecting them, so `spawn_subagent` works without the caller having
 * to know the concrete provider/model ids.
 */
const INHERIT_SENTINELS = new Set(['default', 'auto', 'inherit', 'parent']);

function isInheritSentinel(value: string): boolean {
  return INHERIT_SENTINELS.has(value.trim().toLowerCase());
}

/** The validated raw fields of a spawn input, before model/agent resolution. */
export type ParsedSubagentInput = {
  readonly task: string;
  readonly label: string;
  readonly maxSteps: number;
  readonly agentName: string | null;
  readonly explicitProvider: ProviderId | null;
  readonly explicitModel: string | null;
  /** `model: "fast" | "smart"` — a tier request instead of a concrete model id. */
  readonly tierHint: 'fast' | 'smart' | null;
  /** A continuation id (item: sub-session continuation) to resume from, or null. */
  readonly resumeId: string | null;
};

export function parseSubagentInput(input: Record<string, unknown>): ParsedSubagentInput {
  const task = stringInput(input.task, 'task').trim();
  if (!task) throw new SubagentInputError('spawn_subagent requires a non-empty task.');
  const provider = providerInput(input.provider);
  const modelRaw = stringInput(input.model, 'model').trim();
  const tierHint = modelRaw === 'fast' || modelRaw === 'smart' ? modelRaw : null;
  const model = tierHint || modelRaw === '' || isInheritSentinel(modelRaw) ? null : modelRaw;
  const agentName = stringInput(input.agent, 'agent').trim() || null;
  const label = stringInput(input.label, 'label', task).trim().slice(0, MAX_LABEL_CHARS);
  const resumeId = stringInput(input.resume, 'resume').trim() || null;
  return {
    task: task.slice(0, MAX_TASK_CHARS),
    label: label || task.slice(0, MAX_LABEL_CHARS),
    maxSteps: boundedSteps(input.maxSteps),
    agentName,
    explicitProvider: provider,
    explicitModel: model,
    tierHint,
    resumeId,
  };
}

/**
 * Parse + resolve a spawn input into a runnable request: look the agent role up
 * (builtin/user/project), then resolve the provider/model through the
 * connected-provider fallback chain (subagent-resolve.ts). Throws
 * {@link SubagentInputError} on bad input or an unknown agent (the error lists
 * the available roles so the model can self-correct).
 */
export async function buildSubagentRequest(
  input: unknown,
  ctx: ToolContext,
): Promise<SubagentRunRequest> {
  const parsed = parseSubagentInput(recordSubagentInput(input));
  let agent: AgentDef | null = null;
  if (parsed.agentName) {
    agent = await findAgent(parsed.agentName, ctx.ws);
    if (!agent) {
      const available = (await listAgents(ctx.ws)).map(agentCatalogLine).join('\n');
      throw new SubagentInputError(
        `unknown agent "${parsed.agentName}". Available agents:\n${available}`,
      );
    }
  }
  const parent = ctx.provider && ctx.model ? { provider: ctx.provider, model: ctx.model } : null;
  const target = await resolveSubagentTarget({
    explicit: { provider: parsed.explicitProvider, model: parsed.explicitModel },
    tierHint: parsed.tierHint,
    agent,
    parent,
  });
  return {
    task: parsed.task,
    label: parsed.label,
    provider: target.provider,
    model: target.model,
    maxSteps: parsed.maxSteps,
    agent,
    fallbacks: target.fallbacks,
    resumeId: parsed.resumeId,
  };
}

function stringInput(value: unknown, field: string, fallback = ''): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') throw new SubagentInputError(`${field} must be a string.`);
  return value;
}

function providerInput(value: unknown): ProviderId | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new SubagentInputError('provider must be a string.');
  const trimmed = value.trim();
  // A blank or placeholder ("default"/"auto"/…) means "inherit the parent provider".
  if (trimmed === '' || isInheritSentinel(trimmed)) return null;
  if (!isProviderId(trimmed)) throw new SubagentInputError(`unknown provider "${trimmed}".`);
  return trimmed;
}

function boundedSteps(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_CHILD_STEPS;
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_CHILD_STEPS;
  return Math.max(1, Math.min(Math.floor(value), MAX_CHILD_STEPS));
}
