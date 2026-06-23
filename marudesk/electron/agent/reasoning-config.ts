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

/*
 * Each reasoning provider accepts a DIFFERENT set of levels — verified against the
 * installed `@ai-sdk/*` enums (and the reference catalog Yeachan-Heo/gajae-code).
 * The standard {@link ReasoningEffort} (minimal·low·medium·high·xhigh·max) is folded
 * onto each provider's own set so a turn never 400s on a level it doesn't have:
 *
 *   - anthropic (output_config.effort): low·medium·high·xhigh·max   — no `minimal`
 *   - openai   (reasoning_effort):      minimal·low·medium·high·xhigh — no `max`
 *   - google   (thinkingLevel):         minimal·low·medium·high      — no `xhigh`/`max`
 *   - xai      (reasoning_effort):      low·medium·high              — no `minimal`/`xhigh`/`max`
 *   - compat   (reasoning_effort):      low·medium·high              — conservative common
 *                                       subset for gpt-oss-style gateways
 */

/** Claude: low·medium·high·xhigh·max — `minimal` folds to `low`. */
function claudeEffort(e: ReasoningEffort): 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
  return e === 'minimal' ? 'low' : e;
}
/** OpenAI: minimal·low·medium·high·xhigh — has no `max`, so `max` folds to `xhigh`. */
function openaiEffort(e: ReasoningEffort): 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' {
  return e === 'max' ? 'xhigh' : e;
}
/** Google: minimal·low·medium·high — `xhigh`/`max` fold to `high`. */
function googleLevel(e: ReasoningEffort): 'minimal' | 'low' | 'medium' | 'high' {
  return e === 'xhigh' || e === 'max' ? 'high' : e;
}
/** xAI + compat gateways: low·medium·high — `minimal` folds to `low`, `xhigh`/`max` to `high`. */
function lowMidHighEffort(e: ReasoningEffort): 'low' | 'medium' | 'high' {
  if (e === 'minimal') return 'low';
  if (e === 'xhigh' || e === 'max') return 'high';
  return e;
}

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
      return { openai: { reasoningEffort: openaiEffort(effort) } };
    case 'compat':
      return { openaiCompatible: { reasoningEffort: lowMidHighEffort(effort) } };
    case 'anthropic':
      return { anthropic: { effort: claudeEffort(effort) } };
    case 'google':
      return { google: { thinkingConfig: { thinkingLevel: googleLevel(effort), includeThoughts: true } } };
    case 'xai':
      return { xai: { reasoningEffort: lowMidHighEffort(effort) } };
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
 * (Reasoning needs no special headroom now: every reasoning dialect is ADAPTIVE —
 * Claude's `output_config.effort`, OpenAI/xAI `reasoning_effort`, Google
 * `thinkingLevel` — so the model fits its thinking within `max_tokens`. The old
 * Anthropic `budget_tokens` mode, which required `max_tokens > budget`, is gone.)
 */
export function maxTokensForTurn(catalogMax?: number): number {
  return catalogMax && catalogMax > 0 ? Math.max(catalogMax, AGENT_MAX_TOKENS) : AGENT_MAX_TOKENS;
}
