import type { ProposeResult } from '../../shared/composer';
import type { ModelDef } from '../../shared/providers';

/**
 * One LLM provider's behavior, registered in {@link ./index.ts}. Adding a new
 * provider is: implement this interface in a new file + add it to the DRIVERS
 * registry + add a {@link ProviderDef} entry in shared/providers.ts. No switch
 * statement to update.
 */
export interface ProviderDriver {
  /** Run the propose_patch tool call and return the validated result. */
  propose(apiKey: string, model: string, userText: string): Promise<ProposeResult>;
  /** List the provider's available models for the picker (dynamic catalog). */
  listModels(apiKey: string): Promise<ModelDef[]>;
}
