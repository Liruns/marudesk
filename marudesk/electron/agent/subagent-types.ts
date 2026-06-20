import type { ProviderId } from '../../shared/providers';
import type { ModelRef } from '../../shared/settings';
import type { AgentDef } from './agents-store';
import type { ToolContext, ToolResult } from './tools/types';

export const MAX_TASK_CHARS = 8_000;
export const MAX_LABEL_CHARS = 80;
export const DEFAULT_CHILD_STEPS = 6;
export const MAX_CHILD_STEPS = 12;
export const MAX_CHILD_RESULT_CHARS = 16_000;

export type SubagentRunRequest = {
  readonly task: string;
  readonly label: string;
  readonly provider: ProviderId;
  readonly model: string;
  readonly maxSteps: number;
  /** The agent role driving the child's system prompt + tool allowlist, if any. */
  readonly agent?: AgentDef | null;
  /**
   * Remaining candidates from the provider-aware resolution chain
   * (subagent-resolve.ts) — walked on a mid-run 429/5xx, parent-loop style.
   */
  readonly fallbacks?: readonly ModelRef[];
  /**
   * Continuation id from a PRIOR child run (item: sub-session continuation). When
   * set, the child seeds its transcript from that saved session instead of
   * starting cold — the new {@link task} rides on as a follow-up user turn. An
   * unknown/evicted id falls back to a cold start. See subagent-continuation.ts.
   */
  readonly resumeId?: string | null;
};

export type SubagentRunner = (
  request: SubagentRunRequest,
  ctx: ToolContext,
) => Promise<ToolResult>;

export type ChildToolCall = {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
};

export type ChildToolResultPart = {
  readonly type: 'tool-result';
  readonly toolCallId: string;
  readonly toolName: string;
  readonly output:
    | { readonly type: 'text'; readonly value: string }
    | { readonly type: 'error-text'; readonly value: string };
};
