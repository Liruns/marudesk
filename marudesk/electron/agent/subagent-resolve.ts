import type { BuiltinProviderId, ProviderId } from '../../shared/providers';
import { getProvider, isBuiltinProviderId, isProviderId } from '../../shared/providers';
import type { ModelRef } from '../../shared/settings';
import { getSettingsSync } from '../settings';
import { resolveProviderAuth } from './resolve-auth';
import type { AgentDef, AgentTier } from './agents-store';

/**
 * Subagent model resolution with provider-aware fallback.
 *
 * The old behavior spawned a child on the parent's exact provider/model (or a
 * single configured delegate) and FAILED the child outright when that provider
 * wasn't connected or errored. This module instead builds an ordered candidate
 * chain — explicit request → agent role preference (cost tier or explicit pair)
 * → the configured delegate → the parent's model → the user's ranked fallback
 * chain — and picks the first candidate whose provider is actually CONNECTED
 * (creds resolve). The unchosen remainder rides along as `fallbacks` so the
 * child runtime can fail over mid-run on a 429/5xx, the same way the parent
 * loop does (loop.ts pickNextFallback).
 */

/**
 * Per-provider tier defaults: `fast` = the cheap/quick delegate for fan-out
 * (explore/research), `smart` = the strong model for judgment-heavy roles
 * (review/planning). Only providers with a sensible static pick are listed;
 * custom endpoints resolve through the parent/delegate/fallback entries instead.
 */
export const TIER_MODELS: Partial<Record<BuiltinProviderId, { fast: string; smart: string }>> = {
  anthropic: { fast: 'claude-haiku-4-5-20251001', smart: 'claude-sonnet-4-6' },
  openai: { fast: 'gpt-5-mini', smart: 'gpt-5' },
  google: { fast: 'gemini-2.5-flash', smart: 'gemini-2.5-pro' },
  xai: { fast: 'grok-build-0.1', smart: 'grok-4.3' },
  'openai-codex': { fast: 'gpt-5-codex', smart: 'gpt-5-codex' },
  'google-caa': { fast: 'gemini-2.5-flash', smart: 'gemini-2.5-pro' },
  ollama: { fast: 'qwen2.5-coder', smart: 'qwen2.5-coder' },
  zai: { fast: 'glm-4.5-air', smart: 'glm-4.6' },
  opencode: { fast: 'grok-code', smart: 'gpt-5.5' },
  openrouter: { fast: 'deepseek/deepseek-chat', smart: 'anthropic/claude-sonnet-4.6' },
  groq: { fast: 'llama-3.3-70b-versatile', smart: 'moonshotai/kimi-k2-instruct' },
  cerebras: { fast: 'llama-3.3-70b', smart: 'qwen-3-235b-a22b-instruct' },
  mistral: { fast: 'mistral-small-latest', smart: 'mistral-large-latest' },
  deepseek: { fast: 'deepseek-chat', smart: 'deepseek-reasoner' },
  together: { fast: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', smart: 'deepseek-ai/DeepSeek-V3' },
  fireworks: {
    fast: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    smart: 'accounts/fireworks/models/deepseek-v3',
  },
};

export type SubagentTarget = {
  provider: ProviderId;
  model: string;
  /** The unchosen remainder of the candidate chain, for mid-run fail-over. */
  fallbacks: ModelRef[];
};

export type ResolveSubagentOpts = {
  /** Explicit provider/model from the tool input (after inherit-sentinel handling). */
  explicit: { provider: ProviderId | null; model: string | null };
  /** A `model: "fast" | "smart"` sentinel from the tool input, when given. */
  tierHint: Exclude<AgentTier, 'inherit'> | null;
  /** The selected agent role, when the caller passed one. */
  agent: AgentDef | null;
  /** The parent turn's provider/model (absent only in degenerate contexts). */
  parent: { provider: ProviderId; model: string } | null;
};

const refKey = (ref: ModelRef): string => `${ref.provider}::${ref.model}`;

/**
 * The model an explicit `provider` with no `model` should mean: the provider's
 * tier pick (when a tier is in play) or its default model.
 */
function providerModel(provider: ProviderId, tier: Exclude<AgentTier, 'inherit'> | null): string | null {
  if (isBuiltinProviderId(provider)) {
    const tiers = TIER_MODELS[provider];
    if (tier && tiers) return tiers[tier];
    return getProvider(provider).defaultModelId;
  }
  return null; // custom endpoints carry no static default here
}

/**
 * Tier candidates ordered by where the user most plausibly has working creds:
 * the parent's provider first, then the delegate's, then the ranked fallback
 * chain's providers, then every remaining provider with a tier entry.
 */
function tierCandidates(
  tier: Exclude<AgentTier, 'inherit'>,
  parent: { provider: ProviderId } | null,
  delegate: ModelRef | null,
  fallbackOrder: readonly ModelRef[],
): { provider: ProviderId; model: string }[] {
  const providers: BuiltinProviderId[] = [];
  const push = (p: unknown): void => {
    if (typeof p !== 'string' || !isBuiltinProviderId(p)) return;
    if (!providers.includes(p)) providers.push(p);
  };
  if (parent) push(parent.provider);
  if (delegate) push(delegate.provider);
  for (const ref of fallbackOrder) push(ref.provider);
  for (const p of Object.keys(TIER_MODELS)) push(p);
  const out: { provider: ProviderId; model: string }[] = [];
  for (const p of providers) {
    const tiers = TIER_MODELS[p];
    if (tiers) out.push({ provider: p, model: tiers[tier] });
  }
  return out;
}

/**
 * Build the ordered candidate chain and pick the first CONNECTED entry. When no
 * candidate's provider resolves creds, the first candidate is returned anyway —
 * the child runtime then surfaces the same human-readable auth failure as
 * before, instead of this resolver inventing a new error path.
 */
export async function resolveSubagentTarget(opts: ResolveSubagentOpts): Promise<SubagentTarget> {
  const settings = getSettingsSync().agent;
  const delegate =
    settings.subagentModel && isBuiltinProviderId(settings.subagentModel.provider)
      ? { provider: settings.subagentModel.provider as ProviderId, model: settings.subagentModel.model }
      : null;
  const fallbackOrder: ModelRef[] = settings.fallback.enabled ? settings.fallback.order : [];

  const agentPref = opts.agent?.modelPref ?? null;
  const tier: Exclude<AgentTier, 'inherit'> | null =
    opts.tierHint ?? (agentPref?.kind === 'tier' && agentPref.tier !== 'inherit' ? agentPref.tier : null);

  const candidates: { provider: ProviderId; model: string }[] = [];
  const seen = new Set<string>();
  const add = (ref: { provider: ProviderId; model: string | null } | null): void => {
    if (!ref || !ref.model) return;
    const entry = { provider: ref.provider, model: ref.model };
    const key = refKey(entry);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(entry);
  };

  // 1. The explicit request always leads: a full pair, or a bare provider
  //    resolved to its tier/default model.
  if (opts.explicit.provider && opts.explicit.model) {
    add({ provider: opts.explicit.provider, model: opts.explicit.model });
  } else if (opts.explicit.provider) {
    add({ provider: opts.explicit.provider, model: providerModel(opts.explicit.provider, tier) });
  } else if (opts.explicit.model && opts.parent) {
    add({ provider: opts.parent.provider, model: opts.explicit.model });
  }
  // 2. The agent role's own preference.
  if (agentPref?.kind === 'explicit') add(agentPref);
  // 3. Tier picks across the user's plausible providers.
  if (tier) for (const ref of tierCandidates(tier, opts.parent, delegate, fallbackOrder)) add(ref);
  // 4. The configured delegate (Settings → Agent → subagent model), then the parent.
  add(delegate);
  add(opts.parent);
  // 5. The user's ranked fail-over chain as the final net.
  for (const ref of fallbackOrder) {
    if (isProviderId(ref.provider)) add({ provider: ref.provider, model: ref.model });
  }

  if (candidates.length === 0) {
    throw new Error('spawn_subagent requires provider/model, or a parent model context.');
  }

  // Probe connectivity in order (one probe per provider — a provider that
  // resolves creds for one model resolves them for all of its models).
  const probed = new Map<string, boolean>();
  let chosenIndex = -1;
  for (let i = 0; i < candidates.length; i += 1) {
    const provider = candidates[i].provider;
    let ok = probed.get(provider);
    if (ok === undefined) {
      ok = (await resolveProviderAuth(provider).catch(() => ({ ok: false as const }))).ok;
      probed.set(provider, ok);
    }
    if (ok) {
      chosenIndex = i;
      break;
    }
  }
  if (chosenIndex === -1) chosenIndex = 0; // nothing connected — let the runtime report it
  const chosen = candidates[chosenIndex];
  return {
    provider: chosen.provider,
    model: chosen.model,
    fallbacks: candidates.filter((_, i) => i !== chosenIndex),
  };
}
