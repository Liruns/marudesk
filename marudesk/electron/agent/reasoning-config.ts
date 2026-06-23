import type { JSONValue } from 'ai';
import type { AgentSendInput } from '../../shared/agent';
import type { BuiltinProviderId } from '../../shared/providers';
import type { ReasoningEffort } from '../../shared/settings';

/**
 * Reasoning-effort → provider-native option mapping for a turn (extracted from
 * loop.ts). Pure functions of (provider, modelId, effort, modelReasoning): no
 * per-model hardcoding beyond the proxy routing, so any model the catalog flags
 * `reasoning` gets the RIGHT knob automatically. Kept apart from the loop so the
 * provider knobs can be reviewed and unit-tested in isolation.
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
 * How each provider expresses reasoning effort on the wire. Each provider takes a
 * DIFFERENT parameter, so the standard {@link ReasoningEffort} enum is mapped onto
 * exactly one of these dialects per turn — instead of the old switch that only
 * knew 5 providers and silently dropped the dial for the other ~20.
 *
 *  - `openai`    — native `@ai-sdk/openai`: `providerOptions.openai.reasoningEffort`
 *                  → `reasoning_effort` (minimal | low | medium | high).
 *  - `compat`    — `@ai-sdk/openai-compatible`: `providerOptions.openaiCompatible.
 *                  reasoningEffort` → `reasoning_effort` (the SDK reads the generic
 *                  `openaiCompatible` namespace for EVERY compat provider).
 *  - `anthropic` — extended thinking: `providerOptions.anthropic.thinking.
 *                  budgetTokens` (mapped from effort via {@link ANTHROPIC_THINKING_BUDGET}).
 *  - `google`    — `providerOptions.google.thinkingConfig.thinkingLevel` (+ surface
 *                  the thoughts).
 *  - `xai`       — `providerOptions.xai.reasoningEffort` (xAI has no `minimal`, so
 *                  it folds to `low`).
 *  - `by-model`  — a subscription PROXY that routes by model id to a native dialect
 *                  exactly as buildModel does: a `claude-*` id speaks anthropic
 *                  thinking, `gpt-5`/`o#` speak the OpenAI Responses API, everything
 *                  else is OpenAI-compatible.
 *  - `none`      — no documented effort knob: the model reasons NATIVELY with no
 *                  control (deepseek-reasoner, Magistral, GLM `thinking`, Kimi …) or
 *                  the endpoint is unverified. Apply nothing, so a reasoning turn
 *                  never 400s on a parameter the provider rejects.
 */
type ReasoningDialect = 'openai' | 'compat' | 'anthropic' | 'google' | 'xai' | 'by-model' | 'none';

/**
 * The per-provider reasoning dialect — the table the agent loop consults to pick
 * each provider's native thinking knob. Keyed over every {@link BuiltinProviderId}
 * so adding a provider to the union forces a decision here (no silent fall-through).
 */
const REASONING_DIALECT: Record<BuiltinProviderId, ReasoningDialect> = {
  // First-party SDKs with a native reasoning knob.
  anthropic: 'anthropic',
  openai: 'openai',
  'openai-codex': 'openai',
  google: 'google',
  'google-caa': 'google',
  'google-vertex': 'google',
  xai: 'xai',
  // OpenAI-compatible gateways whose reasoning models accept `reasoning_effort`
  // (Azure IS the OpenAI API; OpenRouter normalises the field; Groq/Cerebras host
  // the gpt-oss family that takes it).
  'azure-openai': 'compat',
  openrouter: 'compat',
  groq: 'compat',
  cerebras: 'compat',
  // Subscription proxies that route by model id to a native dialect (see buildModel).
  'github-copilot': 'by-model',
  'gitlab-duo': 'by-model',
  // Reason natively or expose a non-effort knob (GLM `thinking`, etc.) / unverified
  // endpoints — sending `reasoning_effort` risks a 400, so leave the dial off. The
  // model still reasons; only the level control is unavailable.
  ollama: 'none',
  zai: 'none',
  opencode: 'none',
  mistral: 'none',
  deepseek: 'none',
  together: 'none',
  fireworks: 'none',
  moonshot: 'none',
  nvidia: 'none',
  venice: 'none',
  huggingface: 'none',
  'amazon-bedrock': 'none',
};

/**
 * Resolve the effective reasoning dialect for a turn. A `custom:<id>` endpoint is
 * OpenAI-compatible, so it maps to `compat`. The `by-model` proxies (GitHub
 * Copilot / GitLab Duo) mirror buildModel's per-model routing: a Claude id speaks
 * anthropic thinking, gpt-5/o-series speak the OpenAI Responses API, everything
 * else is OpenAI-compatible. `modelId` is therefore required for those two; for
 * every other provider it is ignored.
 */
export function resolveReasoningDialect(
  provider: AgentSendInput['provider'],
  modelId: string,
): Exclude<ReasoningDialect, 'by-model'> {
  const dialect = (REASONING_DIALECT as Record<string, ReasoningDialect | undefined>)[provider] ?? 'compat';
  if (dialect !== 'by-model') return dialect;
  if (/^claude/i.test(modelId)) return 'anthropic';
  if (provider === 'github-copilot' && /^(gpt-5|o[0-9])/i.test(modelId)) return 'openai';
  return 'compat';
}

/** The provider-native reasoning options for a resolved dialect (empty for `none`). */
function effortOptions(
  dialect: Exclude<ReasoningDialect, 'by-model'>,
  effort: ReasoningEffort,
): Record<string, Record<string, JSONValue>> {
  switch (dialect) {
    case 'openai':
      return { openai: { reasoningEffort: effort } };
    case 'compat':
      return { openaiCompatible: { reasoningEffort: effort } };
    case 'anthropic':
      return { anthropic: { thinking: { type: 'enabled', budgetTokens: ANTHROPIC_THINKING_BUDGET[effort] } } };
    case 'google':
      return { google: { thinkingConfig: { thinkingLevel: effort, includeThoughts: true } } };
    case 'xai':
      return { xai: { reasoningEffort: effort === 'minimal' ? 'low' : effort } };
    case 'none':
      return {};
  }
}

/**
 * Map the standard reasoning-effort enum onto the active provider/model's NATIVE
 * knob. Called only when the selected model actually reasons; otherwise the effort
 * is ignored. Exposed for tests so the whole mapping table is assertable.
 */
export function reasoningProviderOptions(
  provider: AgentSendInput['provider'],
  effort: ReasoningEffort,
  modelId = '',
): Record<string, Record<string, JSONValue>> {
  return effortOptions(resolveReasoningDialect(provider, modelId), effort);
}

/** Whether a turn's resolved dialect is Anthropic extended thinking (drives the max-tokens headroom). */
function isAnthropicThinking(
  provider: AgentSendInput['provider'],
  modelReasoning: boolean,
  modelId: string,
): boolean {
  return modelReasoning && resolveReasoningDialect(provider, modelId) === 'anthropic';
}

/**
 * Assemble `streamText`'s `providerOptions` for the turn: the codex backend's
 * required `{ openai: { store:false, instructions } }` (when applicable) MERGED
 * with the per-provider reasoning knob (when the model reasons). Per-namespace
 * merge keeps codex's `openai` options when openai reasoning also lands there.
 *
 * `modelId` selects the right knob for the `by-model` subscription proxies (Copilot
 * / GitLab Duo); for every other provider it is ignored, so the harnesses that omit
 * it keep their behaviour.
 */
export function buildProviderOptions(
  provider: AgentSendInput['provider'],
  system: string,
  modelReasoning: boolean,
  effort: ReasoningEffort,
  modelId = '',
): Record<string, Record<string, JSONValue>> | undefined {
  const opts: Record<string, Record<string, JSONValue>> =
    provider === 'openai-codex'
      ? { openai: { store: false, instructions: system } }
      : provider === 'xai'
        ? { xai: { store: false } }
        : {};
  if (modelReasoning) {
    for (const [ns, value] of Object.entries(reasoningProviderOptions(provider, effort, modelId))) {
      opts[ns] = { ...opts[ns], ...value };
    }
  }
  return Object.keys(opts).length > 0 ? opts : undefined;
}

/**
 * Output-token cap for the turn (SECOND-PASS item 1). `catalogMax` is the selected
 * model's documented per-call output ceiling; the flat {@link AGENT_MAX_TOKENS} is
 * only a FLOOR/fallback for models the catalog has no value for.
 *
 * Anthropic extended thinking REQUIRES max_tokens > thinking.budget_tokens (or the
 * API 400s), so a reasoning Anthropic-DIALECT turn's cap is raised to at least the
 * thinking budget plus answer headroom even when the catalog value is smaller —
 * including Claude served through the `by-model` proxies (Copilot / GitLab Duo).
 */
export function maxTokensForTurn(
  provider: AgentSendInput['provider'],
  modelReasoning: boolean,
  effort: ReasoningEffort,
  catalogMax?: number,
  modelId = '',
): number {
  const base = catalogMax && catalogMax > 0 ? Math.max(catalogMax, AGENT_MAX_TOKENS) : AGENT_MAX_TOKENS;
  if (isAnthropicThinking(provider, modelReasoning, modelId)) {
    return Math.max(base, ANTHROPIC_THINKING_BUDGET[effort] + AGENT_MAX_TOKENS);
  }
  return base;
}
