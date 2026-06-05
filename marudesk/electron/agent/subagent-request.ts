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
  const model = stringInput(input.model, 'model', ctx.model).trim();
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
  if (!isProviderId(trimmed)) throw new SubagentInputError(`unknown provider "${trimmed}".`);
  return trimmed;
}

function boundedSteps(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_CHILD_STEPS;
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_CHILD_STEPS;
  return Math.max(1, Math.min(Math.floor(value), MAX_CHILD_STEPS));
}
