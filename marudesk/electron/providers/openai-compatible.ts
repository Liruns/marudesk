import type { ModelDef } from '../../shared/providers';
import type { ProviderDriver } from './types';
import { ProviderAuthError, isAuthStatus, prettifyId } from './tool';

/**
 * A reusable driver for OpenAI-compatible providers whose only per-vendor
 * difference is the base URL — OpenRouter / Groq / Cerebras / Mistral / DeepSeek
 * (docs/provider-expansion-plan.md). They all expose `GET <base>/models` returning
 * `{ data: [{ id }] }` behind a Bearer key, so a single factory replaces five
 * near-identical files (cf. the standalone zai/opencode drivers, which predate it).
 * Only reached once an API key is stored; before that the static catalog seeds the
 * picker. A 401/403 surfaces as {@link ProviderAuthError} so a bad key is reported
 * (and powers the Settings "Test connection" button) rather than silently falling
 * back to the seed.
 */
export function openAiCompatibleDriver(opts: {
  /** Human label used only in error messages. */
  name: string;
  /** The fully-qualified `/models` endpoint. */
  modelsUrl: string;
}): ProviderDriver {
  return {
    async listModels(apiKey: string): Promise<ModelDef[]> {
      const resp = await fetch(opts.modelsUrl, {
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      });
      if (!resp.ok) {
        const detail = (await resp.text().catch(() => '')).slice(0, 200);
        const message = `${opts.name} /models returned HTTP ${resp.status}: ${detail}`;
        if (isAuthStatus(resp.status)) throw new ProviderAuthError(message, resp.status);
        throw new Error(message);
      }
      const json = (await resp.json()) as { data?: { id?: unknown }[] };
      return (json.data ?? [])
        .filter((m): m is { id: string } => typeof m.id === 'string')
        .map((m) => ({ id: m.id, label: prettifyId(m.id) }))
        .sort((a, b) => a.id.localeCompare(b.id));
    },
  };
}
