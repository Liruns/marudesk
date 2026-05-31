import type { ProviderId } from '../../shared/providers';
import type { ProviderDriver } from './types';
import { anthropicDriver } from './anthropic';
import { openaiDriver } from './openai';
import { googleDriver } from './google';
import { ollamaDriver } from './ollama';
import { xaiDriver } from './xai';

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
};

export type { ProviderDriver } from './types';
