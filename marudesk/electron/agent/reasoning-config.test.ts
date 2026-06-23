import { describe, expect, it } from 'vitest';
import {
  AGENT_MAX_TOKENS,
  buildProviderOptions,
  maxTokensForTurn,
  reasoningProviderOptions,
  resolveReasoningDialect,
} from './reasoning-config';

describe('resolveReasoningDialect — per-provider thinking dialect', () => {
  it('maps first-party SDKs to their native dialect', () => {
    expect(resolveReasoningDialect('anthropic', 'claude-sonnet-4-6')).toBe('anthropic');
    expect(resolveReasoningDialect('openai', 'gpt-5')).toBe('openai');
    expect(resolveReasoningDialect('openai-codex', 'gpt-5')).toBe('openai');
    expect(resolveReasoningDialect('google', 'gemini-2.5-pro')).toBe('google');
    expect(resolveReasoningDialect('google-caa', 'gemini-2.5-pro')).toBe('google');
    expect(resolveReasoningDialect('google-vertex', 'gemini-2.5-pro')).toBe('google');
    expect(resolveReasoningDialect('xai', 'grok-4.3')).toBe('xai');
  });

  it('maps OpenAI-compatible gateways that accept reasoning_effort to compat', () => {
    for (const p of ['azure-openai', 'openrouter', 'groq', 'cerebras'] as const) {
      expect(resolveReasoningDialect(p, 'gpt-oss-120b')).toBe('compat');
    }
  });

  it('treats a custom:<id> endpoint as OpenAI-compatible', () => {
    expect(resolveReasoningDialect('custom:lmstudio', 'qwen3')).toBe('compat');
  });

  it('leaves natively-reasoning / unverified providers without an effort dial', () => {
    for (const p of ['deepseek', 'mistral', 'zai', 'moonshot', 'ollama', 'amazon-bedrock'] as const) {
      expect(resolveReasoningDialect(p, 'whatever')).toBe('none');
    }
  });

  it('routes the by-model subscription proxies by model id (mirrors buildModel)', () => {
    // GitHub Copilot: claude → anthropic, gpt-5/o-series → openai, else → compat.
    expect(resolveReasoningDialect('github-copilot', 'claude-3.7-sonnet')).toBe('anthropic');
    expect(resolveReasoningDialect('github-copilot', 'gpt-5')).toBe('openai');
    expect(resolveReasoningDialect('github-copilot', 'o3')).toBe('openai');
    expect(resolveReasoningDialect('github-copilot', 'gemini-2.5-pro')).toBe('compat');
    // GitLab Duo: claude → anthropic, everything else → compat (no native openai path).
    expect(resolveReasoningDialect('gitlab-duo', 'claude-sonnet-4-6')).toBe('anthropic');
    expect(resolveReasoningDialect('gitlab-duo', 'gpt-5')).toBe('compat');
  });
});

describe('reasoningProviderOptions — the on-the-wire knob per dialect', () => {
  it('openai → reasoningEffort under the openai namespace', () => {
    expect(reasoningProviderOptions('openai', 'high', 'gpt-5')).toEqual({ openai: { reasoningEffort: 'high' } });
  });

  it('compat → reasoningEffort under the generic openaiCompatible namespace', () => {
    expect(reasoningProviderOptions('groq', 'medium', 'gpt-oss-120b')).toEqual({
      openaiCompatible: { reasoningEffort: 'medium' },
    });
  });

  it('anthropic → a thinking token budget, not an enum', () => {
    expect(reasoningProviderOptions('anthropic', 'high', 'claude-sonnet-4-6')).toEqual({
      anthropic: { thinking: { type: 'enabled', budgetTokens: 24000 } },
    });
  });

  it('google → thinkingConfig.thinkingLevel + surfaced thoughts', () => {
    expect(reasoningProviderOptions('google', 'low', 'gemini-2.5-pro')).toEqual({
      google: { thinkingConfig: { thinkingLevel: 'low', includeThoughts: true } },
    });
  });

  it('xai folds minimal → low (xAI has no minimal)', () => {
    expect(reasoningProviderOptions('xai', 'minimal', 'grok-4.3')).toEqual({ xai: { reasoningEffort: 'low' } });
    expect(reasoningProviderOptions('xai', 'high', 'grok-4.3')).toEqual({ xai: { reasoningEffort: 'high' } });
  });

  it('none → no options (so a reasoning turn never 400s on an unsupported param)', () => {
    expect(reasoningProviderOptions('deepseek', 'high', 'deepseek-reasoner')).toEqual({});
  });

  it('a Claude model on Copilot gets the anthropic budget, not reasoning_effort', () => {
    expect(reasoningProviderOptions('github-copilot', 'medium', 'claude-3.7-sonnet')).toEqual({
      anthropic: { thinking: { type: 'enabled', budgetTokens: 12000 } },
    });
  });
});

describe('buildProviderOptions — merges backend envelope with the reasoning knob', () => {
  it('omits the reasoning knob for a non-reasoning model', () => {
    expect(buildProviderOptions('openai', 'sys', false, 'high', 'gpt-4.1')).toBeUndefined();
  });

  it('merges codex store:false + instructions with openai reasoning in one namespace', () => {
    expect(buildProviderOptions('openai-codex', 'SYS', true, 'low', 'gpt-5')).toEqual({
      openai: { store: false, instructions: 'SYS', reasoningEffort: 'low' },
    });
  });

  it('keeps xai store:false alongside its reasoning effort', () => {
    expect(buildProviderOptions('xai', 'sys', true, 'high', 'grok-4.3')).toEqual({
      xai: { store: false, reasoningEffort: 'high' },
    });
  });

  it('adds a compat reasoning knob for a gateway reasoning model', () => {
    expect(buildProviderOptions('openrouter', 'sys', true, 'medium', 'openai/gpt-oss-120b')).toEqual({
      openaiCompatible: { reasoningEffort: 'medium' },
    });
  });
});

describe('maxTokensForTurn — Anthropic thinking needs headroom over the budget', () => {
  it('falls back to the floor with no catalog value', () => {
    expect(maxTokensForTurn('openai', false, 'medium')).toBe(AGENT_MAX_TOKENS);
  });

  it('clamps a sub-floor catalog value up to the floor', () => {
    expect(maxTokensForTurn('openai', false, 'medium', 1000)).toBe(AGENT_MAX_TOKENS);
  });

  it('lifts the cap to the catalog ceiling on a non-reasoning path', () => {
    expect(maxTokensForTurn('openai', true, 'high', 128_000)).toBe(128_000);
  });

  it('raises a small catalog cap to budget+headroom for Anthropic thinking', () => {
    expect(maxTokensForTurn('anthropic', true, 'high', 20_000)).toBe(24_000 + AGENT_MAX_TOKENS);
  });

  it('applies the same headroom to Claude served through Copilot (by-model)', () => {
    expect(maxTokensForTurn('github-copilot', true, 'high', 20_000, 'claude-3.7-sonnet')).toBe(
      24_000 + AGENT_MAX_TOKENS,
    );
  });

  it('does NOT apply the Anthropic headroom to a non-Claude Copilot model', () => {
    // gpt-5 on Copilot resolves to the openai dialect, so the cap is just the
    // catalog value (20000) — NOT lifted to budget+headroom (24000+4096).
    expect(maxTokensForTurn('github-copilot', true, 'high', 20_000, 'gpt-5')).toBe(20_000);
  });
});
