import type { ModelDef } from '../../shared/providers';
import type { ProviderDriver } from './types';
import { ProviderAuthError, isAuthStatus, prettifyId } from './tool';

/**
 * Z.ai (Zhipu GLM) live model catalog. The OpenAI-compatible list endpoint takes
 * a Bearer credential (the ZHIPU_API_KEY). Only reached when an API key is stored;
 * before that the static catalog (shared/providers.ts) seeds the picker. See the
 * provider research in docs / models.dev `providers/zai`.
 */
async function listModels(apiKey: string): Promise<ModelDef[]> {
  const resp = await fetch('https://api.z.ai/api/paas/v4/models', {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!resp.ok) {
    const detail = (await resp.text().catch(() => '')).slice(0, 200);
    const message = `Z.ai /models returned HTTP ${resp.status}: ${detail}`;
    if (isAuthStatus(resp.status)) throw new ProviderAuthError(message, resp.status);
    throw new Error(message);
  }
  const json = (await resp.json()) as { data?: { id?: unknown }[] };
  return (json.data ?? [])
    .filter((m): m is { id: string } => typeof m.id === 'string')
    .map((m) => ({ id: m.id, label: prettifyId(m.id) }));
}

export const zaiDriver: ProviderDriver = { listModels };
