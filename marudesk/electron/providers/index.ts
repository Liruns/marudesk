import type { ProviderId } from '../../shared/providers';
import type { ProviderDriver } from './types';
import { anthropicDriver } from './anthropic';
import { openaiDriver } from './openai';
import { googleDriver } from './google';

/**
 * The provider registry. `proposePatch` (llm.ts) and `getModelsFor` (models.ts)
 * dispatch through this instead of a `switch (provider)`, so a new provider is
 * one new driver file + one entry here + one {@link ProviderDef} in
 * shared/providers.ts — the union type makes a missing entry a compile error.
 */
export const DRIVERS: Record<ProviderId, ProviderDriver> = {
  anthropic: anthropicDriver,
  openai: openaiDriver,
  google: googleDriver,
};

export type { ProviderDriver } from './types';
