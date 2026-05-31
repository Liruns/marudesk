import type { ModelDef } from '../../shared/providers';

/**
 * One LLM provider's behavior, registered in {@link ./index.ts}. Since the agent
 * moved onto the Vercel AI SDK (docs/agentic-chat-v2-design.md §4), a driver's
 * only job is contributing the provider's live model catalog. Adding a provider
 * is: implement this interface in a new file + add it to the DRIVERS registry +
 * add a {@link ProviderDef} entry in shared/providers.ts. No switch to update.
 */
export interface ProviderDriver {
  /** List the provider's available models for the picker (dynamic catalog). */
  listModels(apiKey: string): Promise<ModelDef[]>;
}
