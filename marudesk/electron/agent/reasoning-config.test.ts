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
    expect(resolveReasoningDialect('google-vertex', 'gemini-2.5-pro')).toBe('google');
    expect(resolveReasoningDialect('xai', 'grok-4.3')).toBe('xai');
  });

  it('maps OpenAI-compatible gateways to compat', () => {
    for (const p of ['azure-openai', 'openrouter', 'groq', 'cerebras'] as const) {
      expect(resolveReasoningDialect(p, 'gpt-oss-120b')).toBe('compat');
    }
    expect(resolveReasoningDialect('custom:lmstudio', 'qwen3')).toBe('compat');
  });

  it('leaves natively-reasoning / unverified providers without an effort dial', () => {
    for (const p of ['deepseek', 'mistral', 'zai', 'moonshot', 'ollama', 'amazon-bedrock'] as const) {
      expect(resolveReasoningDialect(p, 'whatever')).toBe('none');
    }
  });

  it('routes the by-model subscription proxies by model id', () => {
    expect(resolveReasoningDialect('github-copilot', 'claude-3.7-sonnet')).toBe('anthropic');
    expect(resolveReasoningDialect('github-copilot', 'gpt-5')).toBe('openai');
    expect(resolveReasoningDialect('github-copilot', 'o3')).toBe('openai');
    expect(resolveReasoningDialect('github-copilot', 'gemini-2.5-pro')).toBe('compat');
    expect(resolveReasoningDialect('gitlab-duo', 'claude-sonnet-4-6')).toBe('anthropic');
    expect(resolveReasoningDialect('gitlab-duo', 'gpt-5')).toBe('compat');
  });
});

describe('reasoningProviderOptions — the on-the-wire knob per dialect', () => {
  it('openai → reasoningEffort (enum) under the openai namespace', () => {
    expect(reasoningProviderOptions('openai', 'high', 'gpt-5')).toEqual({ openai: { reasoningEffort: 'high' } });
  });

  it('compat → reasoningEffort under the generic openaiCompatible namespace', () => {
    expect(reasoningProviderOptions('groq', 'medium', 'gpt-oss-120b')).toEqual({
      openaiCompatible: { reasoningEffort: 'medium' },
    });
  });

  it('Claude → an adaptive effort STRING (output_config.effort), not a budget', () => {
    expect(reasoningProviderOptions('anthropic', 'high', 'claude-sonnet-4-6')).toEqual({
      anthropic: { effort: 'high' },
    });
    // Claude HAS the high tiers the catalog's 4.x models support…
    expect(reasoningProviderOptions('anthropic', 'xhigh', 'claude-opus-4-8')).toEqual({ anthropic: { effort: 'xhigh' } });
    expect(reasoningProviderOptions('anthropic', 'max', 'claude-opus-4-8')).toEqual({ anthropic: { effort: 'max' } });
    // …but no `minimal`, so it folds to low.
    expect(reasoningProviderOptions('anthropic', 'minimal', 'claude-sonnet-4-6')).toEqual({ anthropic: { effort: 'low' } });
  });

  it('OpenAI keeps xhigh (it HAS that level) but folds max→xhigh (no max tier)', () => {
    // Verified against @ai-sdk/openai: reasoning_effort ∈ minimal|low|medium|high|xhigh.
    expect(reasoningProviderOptions('openai', 'xhigh', 'gpt-5.1')).toEqual({ openai: { reasoningEffort: 'xhigh' } });
    expect(reasoningProviderOptions('openai', 'max', 'gpt-5.1')).toEqual({ openai: { reasoningEffort: 'xhigh' } });
    expect(reasoningProviderOptions('openai', 'minimal', 'gpt-5')).toEqual({ openai: { reasoningEffort: 'minimal' } });
  });

  it('Google keeps minimal but folds xhigh/max→high (thinkingLevel has no xhigh)', () => {
    // Verified against @ai-sdk/google: thinkingLevel ∈ minimal|low|medium|high.
    expect(reasoningProviderOptions('google', 'minimal', 'gemini-2.5-flash')).toEqual({
      google: { thinkingConfig: { thinkingLevel: 'minimal', includeThoughts: true } },
    });
    expect(reasoningProviderOptions('google', 'xhigh', 'gemini-2.5-pro')).toEqual({
      google: { thinkingConfig: { thinkingLevel: 'high', includeThoughts: true } },
    });
  });

  it('xAI is low/medium/high — minimal→low, medium passes, xhigh/max→high', () => {
    // Verified against @ai-sdk/xai (responses): reasoning_effort ∈ low|medium|high.
    expect(reasoningProviderOptions('xai', 'minimal', 'grok-4.3')).toEqual({ xai: { reasoningEffort: 'low' } });
    expect(reasoningProviderOptions('xai', 'medium', 'grok-4.3')).toEqual({ xai: { reasoningEffort: 'medium' } });
    expect(reasoningProviderOptions('xai', 'xhigh', 'grok-4.3')).toEqual({ xai: { reasoningEffort: 'high' } });
  });

  it('compat gateways use the conservative low/medium/high subset', () => {
    expect(reasoningProviderOptions('groq', 'minimal', 'gpt-oss')).toEqual({ openaiCompatible: { reasoningEffort: 'low' } });
    expect(reasoningProviderOptions('groq', 'max', 'gpt-oss')).toEqual({ openaiCompatible: { reasoningEffort: 'high' } });
  });

  it('none → no options (so a reasoning turn never 400s on an unsupported param)', () => {
    expect(reasoningProviderOptions('deepseek', 'high', 'deepseek-reasoner')).toEqual({});
  });

  it('a Claude model on Copilot gets the anthropic effort, not reasoning_effort', () => {
    expect(reasoningProviderOptions('github-copilot', 'xhigh', 'claude-3.7-sonnet')).toEqual({
      anthropic: { effort: 'xhigh' },
    });
  });
});

describe('buildProviderOptions — merges backend envelope with the reasoning knob', () => {
  it('omits the reasoning knob for a non-reasoning model', () => {
    expect(buildProviderOptions('openai', 'sys', false, 'high', 'gpt-4.1')).toBeUndefined();
  });

  it('merges codex store:false + instructions with openai reasoning', () => {
    expect(buildProviderOptions('openai-codex', 'SYS', true, 'low', 'gpt-5')).toEqual({
      openai: { store: false, instructions: 'SYS', reasoningEffort: 'low' },
    });
  });

  it('keeps xai store:false alongside its reasoning effort', () => {
    expect(buildProviderOptions('xai', 'sys', true, 'high', 'grok-4.3')).toEqual({
      xai: { store: false, reasoningEffort: 'high' },
    });
  });

  it('adds the Claude effort for a reasoning Claude model', () => {
    expect(buildProviderOptions('anthropic', 'sys', true, 'max', 'claude-opus-4-8')).toEqual({
      anthropic: { effort: 'max' },
    });
  });
});

describe('maxTokensForTurn — just the catalog cap (reasoning is adaptive now)', () => {
  it('falls back to the floor with no catalog value', () => {
    expect(maxTokensForTurn()).toBe(AGENT_MAX_TOKENS);
  });

  it('clamps a sub-floor catalog value up to the floor', () => {
    expect(maxTokensForTurn(1000)).toBe(AGENT_MAX_TOKENS);
  });

  it('lifts the cap to the catalog ceiling', () => {
    expect(maxTokensForTurn(128_000)).toBe(128_000);
  });
});
