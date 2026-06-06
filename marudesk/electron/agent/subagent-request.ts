import type { ProviderId } from '../../shared/providers';
import { isProviderId } from '../../shared/providers';
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

export function parseSubagentRequest(
  input: Record<string, unknown>,
  ctx: ToolContext,
): SubagentRunRequest {
  const task = stringInput(input.task, 'task').trim();
  if (!task) throw new SubagentInputError('spawn_subagent requires a non-empty task.');
  const provider = providerInput(input.provider, ctx.provider);
  if (!provider) {
    throw new SubagentInputError('spawn_subagent requires provider, or a parent provider context.');
  }
  const model = modelInput(input.model, ctx.model);
  if (!model) throw new SubagentInputError('spawn_subagent requires model, or a parent model context.');
  const label = stringInput(input.label, 'label', task).trim().slice(0, MAX_LABEL_CHARS);
  return {
    task: task.slice(0, MAX_TASK_CHARS),
    label: label || task.slice(0, MAX_LABEL_CHARS),
    provider,
    model,
    maxSteps: boundedSteps(input.maxSteps),
  };
}

function stringInput(value: unknown, field: string, fallback = ''): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') throw new SubagentInputError(`${field} must be a string.`);
  return value;
}

function providerInput(value: unknown, fallback: ProviderId | undefined): ProviderId | null {
  if (value === undefined || value === null || value === '') return fallback ?? null;
  if (typeof value !== 'string') throw new SubagentInputError('provider must be a string.');
  const trimmed = value.trim();
  // A blank or placeholder ("default"/"auto"/…) means "inherit the parent provider".
  if (trimmed === '' || isInheritSentinel(trimmed)) return fallback ?? null;
  if (!isProviderId(trimmed)) throw new SubagentInputError(`unknown provider "${trimmed}".`);
  return trimmed;
}

function modelInput(value: unknown, fallback: string | undefined): string {
  if (value === undefined || value === null || value === '') return (fallback ?? '').trim();
  if (typeof value !== 'string') throw new SubagentInputError('model must be a string.');
  const trimmed = value.trim();
  // A blank or placeholder ("default"/"auto"/…) means "inherit the parent model".
  if (trimmed === '' || isInheritSentinel(trimmed)) return (fallback ?? '').trim();
  return trimmed;
}

function boundedSteps(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_CHILD_STEPS;
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_CHILD_STEPS;
  return Math.max(1, Math.min(Math.floor(value), MAX_CHILD_STEPS));
}
