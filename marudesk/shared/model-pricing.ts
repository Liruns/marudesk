/**
 * Estimated USD pricing for well-known hosted models, by model-id pattern.
 *
 * ⚠ These are ESTIMATES from publicly published per-token list prices as of
 * 2026-06. They ignore prompt caching, batch discounts, long-context tiers,
 * thinking-token surcharges, and gateway (OpenRouter/Zen) markups — actual
 * billing can differ. Vendors also reprice; treat every figure here as
 * approximate and refresh the table when prices change.
 *
 * Pure module (no electron/react imports) so it's reusable across main,
 * renderer, and tests per the shared/* contract. Matching is substring-style
 * regex over the model id, so gateway ids like `anthropic/claude-sonnet-4.6`
 * resolve too. Unknown ids — local models (Ollama), unpriced gateways, new
 * releases — return null, and callers hide the estimate.
 */

type ModelPricing = {
  /** Matches the model id (case-insensitive). Order matters: first hit wins. */
  pattern: RegExp;
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
};

/**
 * Ordered pattern table — more specific variants (mini/nano/lite/pro) must
 * precede their base family so e.g. `gpt-5-mini` never bills as `gpt-5`.
 * Separators tolerate both `4-6` and `4.6` id styles ([.-]).
 */
const PRICING_TABLE: readonly ModelPricing[] = [
  // ── Anthropic (list prices, 2026-06) ──────────────────────────────────
  { pattern: /claude-(fable|mythos)-5/i, inputPerMTok: 10, outputPerMTok: 50 },
  // Opus 4.5+ repriced to $5/$25; Opus 4.0/4.1 (and Claude 3 Opus) were $15/$75.
  { pattern: /claude-opus-4[.-][5-9]/i, inputPerMTok: 5, outputPerMTok: 25 },
  { pattern: /claude-opus-4/i, inputPerMTok: 15, outputPerMTok: 75 },
  { pattern: /claude-3-opus/i, inputPerMTok: 15, outputPerMTok: 75 },
  { pattern: /claude-sonnet-4/i, inputPerMTok: 3, outputPerMTok: 15 },
  { pattern: /claude-3[.-]7-sonnet/i, inputPerMTok: 3, outputPerMTok: 15 },
  { pattern: /claude-3[.-]5-sonnet/i, inputPerMTok: 3, outputPerMTok: 15 },
  { pattern: /claude-haiku-4/i, inputPerMTok: 1, outputPerMTok: 5 },
  { pattern: /claude-3[.-]5-haiku/i, inputPerMTok: 0.8, outputPerMTok: 4 },
  { pattern: /claude-3-haiku/i, inputPerMTok: 0.25, outputPerMTok: 1.25 },

  // ── OpenAI ────────────────────────────────────────────────────────────
  // gpt-5 family list prices; later 5.x point releases (5.3/5.5/codex) are
  // mapped onto the base gpt-5 rate as a best-effort estimate.
  { pattern: /gpt-5(\.\d+)?-nano/i, inputPerMTok: 0.05, outputPerMTok: 0.4 },
  { pattern: /gpt-5(\.\d+)?-mini/i, inputPerMTok: 0.25, outputPerMTok: 2 },
  { pattern: /gpt-5/i, inputPerMTok: 1.25, outputPerMTok: 10 },
  { pattern: /gpt-4o-mini/i, inputPerMTok: 0.15, outputPerMTok: 0.6 },
  { pattern: /gpt-4o/i, inputPerMTok: 2.5, outputPerMTok: 10 },
  { pattern: /gpt-4\.1-nano/i, inputPerMTok: 0.1, outputPerMTok: 0.4 },
  { pattern: /gpt-4\.1-mini/i, inputPerMTok: 0.4, outputPerMTok: 1.6 },
  { pattern: /gpt-4\.1/i, inputPerMTok: 2, outputPerMTok: 8 },
  { pattern: /\bo3-pro\b/i, inputPerMTok: 20, outputPerMTok: 80 },
  { pattern: /\bo[34]-mini\b/i, inputPerMTok: 1.1, outputPerMTok: 4.4 },
  { pattern: /\bo3\b/i, inputPerMTok: 2, outputPerMTok: 8 },

  // ── Google Gemini ─────────────────────────────────────────────────────
  // 2.5 Pro is the ≤200K-prompt tier; long-context prompts bill higher.
  { pattern: /gemini-2\.5-flash-lite/i, inputPerMTok: 0.1, outputPerMTok: 0.4 },
  { pattern: /gemini-2\.5-flash/i, inputPerMTok: 0.3, outputPerMTok: 2.5 },
  { pattern: /gemini-2\.5-pro/i, inputPerMTok: 1.25, outputPerMTok: 10 },

  // ── xAI Grok ──────────────────────────────────────────────────────────
  // grok-3/4 list prices; retired ids redirect to grok-4.3 at the same rate.
  { pattern: /grok-3-mini/i, inputPerMTok: 0.3, outputPerMTok: 0.5 },
  { pattern: /grok-3/i, inputPerMTok: 3, outputPerMTok: 15 },
  { pattern: /grok-4/i, inputPerMTok: 3, outputPerMTok: 15 },
];

/** The matched per-MTok pricing for a model id, or null when unknown. */
export function findModelPricing(modelId: string): ModelPricing | null {
  if (!modelId) return null;
  for (const entry of PRICING_TABLE) {
    if (entry.pattern.test(modelId)) return entry;
  }
  return null;
}

/**
 * Estimated USD cost for a token total against a model's published list price.
 * Returns null for unknown/local models (e.g. Ollama) so the UI can hide the
 * figure instead of showing a misleading $0. Estimate only — see module doc.
 */
export function estimateCostUsd(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const pricing = findModelPricing(modelId);
  if (!pricing) return null;
  const safeIn = Number.isFinite(inputTokens) && inputTokens > 0 ? inputTokens : 0;
  const safeOut = Number.isFinite(outputTokens) && outputTokens > 0 ? outputTokens : 0;
  return (safeIn * pricing.inputPerMTok + safeOut * pricing.outputPerMTok) / 1_000_000;
}

/**
 * Compact dollar label for an estimate: `$1.23`, `$0.046`, `$0.0008`. Scales
 * precision down with magnitude so small conversations don't read as `$0.00`.
 */
export function formatCostUsd(cost: number): string {
  if (!Number.isFinite(cost) || cost < 0) return '$0.00';
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  if (cost >= 0.01) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(4)}`;
}
