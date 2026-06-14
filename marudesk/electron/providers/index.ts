import type { ProviderId } from '../../shared/providers';
import type { ProviderDriver } from './types';
import { anthropicDriver } from './anthropic';
import { openaiDriver } from './openai';
import { googleDriver } from './google';
import { ollamaDriver } from './ollama';
import { xaiDriver } from './xai';
import { zaiDriver } from './zai';
import { opencodeDriver } from './opencode';
import { openAiCompatibleDriver } from './openai-compatible';

/**
 * OAuth-only subscription providers (openai-codex / google-caa) have no API-key
 * model endpoint — models.ts returns their static catalog (no key ⇒ no live
 * fetch), so this driver is never actually invoked; it just satisfies the
 * DRIVERS map's exhaustive key type.
 */
const oauthOnlyDriver: ProviderDriver = { listModels: async () => [] };

/**
 * The provider registry. `getModelsFor` (models.ts) dispatches through this
 * instead of a `switch (provider)`, so a new provider is one new driver file +
 * one entry here + one {@link ProviderDef} in shared/providers.ts — the union
 * type makes a missing entry a compile error.
 */
export const DRIVERS: Record<ProviderId, ProviderDriver> = {
  anthropic: anthropicDriver,
  openai: openaiDriver,
  google: googleDriver,
  ollama: ollamaDriver,
  xai: xaiDriver,
  'openai-codex': oauthOnlyDriver,
  'google-caa': oauthOnlyDriver,
  zai: zaiDriver,
  opencode: opencodeDriver,
  // OpenAI-compatible API-key gateways (docs/provider-expansion-plan.md) — one
  // factory, one base URL each.
  openrouter: openAiCompatibleDriver({
    name: 'OpenRouter',
    modelsUrl: 'https://openrouter.ai/api/v1/models',
  }),
  groq: openAiCompatibleDriver({
    name: 'Groq',
    modelsUrl: 'https://api.groq.com/openai/v1/models',
  }),
  cerebras: openAiCompatibleDriver({
    name: 'Cerebras',
    modelsUrl: 'https://api.cerebras.ai/v1/models',
  }),
  mistral: openAiCompatibleDriver({
    name: 'Mistral',
    modelsUrl: 'https://api.mistral.ai/v1/models',
  }),
  deepseek: openAiCompatibleDriver({
    name: 'DeepSeek',
    modelsUrl: 'https://api.deepseek.com/v1/models',
  }),
  together: openAiCompatibleDriver({
    name: 'Together AI',
    modelsUrl: 'https://api.together.xyz/v1/models',
  }),
  fireworks: openAiCompatibleDriver({
    name: 'Fireworks AI',
    modelsUrl: 'https://api.fireworks.ai/inference/v1/models',
  }),
  moonshot: openAiCompatibleDriver({
    name: 'Moonshot',
    modelsUrl: 'https://api.moonshot.ai/v1/models',
  }),
  nvidia: openAiCompatibleDriver({
    name: 'NVIDIA NIM',
    modelsUrl: 'https://integrate.api.nvidia.com/v1/models',
  }),
  venice: openAiCompatibleDriver({
    name: 'Venice',
    modelsUrl: 'https://api.venice.ai/api/v1/models',
  }),
  huggingface: openAiCompatibleDriver({
    name: 'Hugging Face',
    modelsUrl: 'https://router.huggingface.co/v1/models',
  }),
  'github-copilot': oauthOnlyDriver,
  'google-vertex': oauthOnlyDriver,
  'amazon-bedrock': oauthOnlyDriver,
  'gitlab-duo': oauthOnlyDriver,
  'azure-openai': oauthOnlyDriver,
};

export type { ProviderDriver } from './types';
