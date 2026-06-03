import type { JSONValue } from 'ai';
import type { AgentSendInput } from '../../shared/agent';
import type { ReasoningEffort } from '../../shared/settings';

/**
 * Reasoning-effort → provider-native option mapping for a turn (extracted from
 * loop.ts). These are pure functions of (provider, effort, modelReasoning): no
 * per-model hardcoding, so any model the catalog flags `reasoning` works
 * automatically. Kept apart from the loop so the provider knobs can be reviewed
 * and unit-tested in isolation.
 */

/** Per-step output-token cap (matches the prior hand-rolled driver). */
export const AGENT_MAX_TOKENS = 4_096;

/**
 * Anthropic's thinking knob is a token budget, not an enum — map the standard
 * {@link ReasoningEffort} levels onto sensible budgets (the higher levels leave
 * ample room under the per-step output cap's siblings; the SDK enforces the rest).
 */
const ANTHROPIC_THINKING_BUDGET: Record<ReasoningEffort, number> = {
  minimal: 1024,
  low: 4000,
  medium: 12000,
  high: 24000,
};

/**
 * Map the standard reasoning-effort enum onto the active provider's NATIVE knob —
 * no per-model hardcoding, so any model the catalog flags `reasoning` works
 * automatically. Called only when the selected model actually reasons; otherwise
 * the effort is ignored. The codex backend keeps its existing `openai` options
 * (store:false + instructions), which the caller merges in first.
 *
 * - openai / openai-codex: `reasoningEffort` ('minimal'|'low'|'medium'|'high').
 * - anthropic: extended thinking with a token budget (see {@link ANTHROPIC_THINKING_BUDGET}).
 * - google / google-caa: `thinkingConfig.thinkingLevel` (+ surface the thoughts).
 * - xai: OpenAI-compatible — the model reads `providerOptions.xai.reasoningEffort`.
 * - everything else (ollama / custom endpoints): skipped — no known reasoning knob.
 */
function reasoningProviderOptions(
  provider: AgentSendInput['provider'],
  effort: ReasoningEffort,
): Record<string, Record<string, JSONValue>> {
  switch (provider) {
    case 'openai':
    case 'openai-codex':
      return { openai: { reasoningEffort: effort } };
    case 'anthropic':
      return { anthropic: { thinking: { type: 'enabled', budgetTokens: ANTHROPIC_THINKING_BUDGET[effort] } } };
    case 'google':
    case 'google-caa':
      return { google: { thinkingConfig: { thinkingLevel: effort, includeThoughts: true } } };
    case 'xai':
      return { xai: { reasoningEffort: effort } };
    default:
      return {};
  }
}

/**
 * Assemble `streamText`'s `providerOptions` for the turn: the codex backend's
 * required `{ openai: { store:false, instructions } }` (when applicable) MERGED
 * with the per-provider reasoning knob (when the model reasons). Per-namespace
 * merge keeps codex's `openai` options when openai reasoning also lands there.
 */
export function buildProviderOptions(
  provider: AgentSendInput['provider'],
  system: string,
  modelReasoning: boolean,
  effort: ReasoningEffort,
): Record<string, Record<string, JSONValue>> | undefined {
  const opts: Record<string, Record<string, JSONValue>> =
    provider === 'openai-codex' ? { openai: { store: false, instructions: system } } : {};
  if (modelReasoning) {
    for (const [ns, value] of Object.entries(reasoningProviderOptions(provider, effort))) {
      opts[ns] = { ...opts[ns], ...value };
    }
  }
  return Object.keys(opts).length > 0 ? opts : undefined;
}

/**
 * Output-token cap for the turn. Anthropic extended thinking REQUIRES
 * max_tokens > thinking.budget_tokens (or the API 400s), so a reasoning Claude
 * turn gets its thinking budget plus answer headroom; every other provider uses
 * the flat per-step cap (their reasoning tokens are managed server-side).
 */
export function maxTokensForTurn(
  provider: AgentSendInput['provider'],
  modelReasoning: boolean,
  effort: ReasoningEffort,
): number {
  if (modelReasoning && provider === 'anthropic') {
    return ANTHROPIC_THINKING_BUDGET[effort] + AGENT_MAX_TOKENS;
  }
  return AGENT_MAX_TOKENS;
}
