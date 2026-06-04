import type { ModelDef } from '../../shared/providers';
import type { ProviderDriver } from './types';
import { ProviderAuthError, isAuthStatus, prettifyId } from './tool';

/**
 * OpenCode Zen live model catalog. OpenCode's gateway (opencode.ai/zen/v1) is a
 * curated multi-vendor catalog behind one OpenAI-compatible endpoint, keyed by an
 * OPENCODE_API_KEY (Bearer). Only reached when a key is stored; the static catalog
 * (shared/providers.ts) seeds the picker beforehand. See models.dev `providers/opencode`.
 */
async function listModels(apiKey: string): Promise<ModelDef[]> {
  const resp = await fetch('https://opencode.ai/zen/v1/models', {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!resp.ok) {
    const detail = (await resp.text().catch(() => '')).slice(0, 200);
    const message = `OpenCode Zen /models returned HTTP ${resp.status}: ${detail}`;
    if (isAuthStatus(resp.status)) throw new ProviderAuthError(message, resp.status);
    throw new Error(message);
  }
  const json = (await resp.json()) as { data?: { id?: unknown }[] };
  return (json.data ?? [])
    .filter((m): m is { id: string } => typeof m.id === 'string')
    .map((m) => ({ id: m.id, label: prettifyId(m.id) }));
}

export const opencodeDriver: ProviderDriver = { listModels };
