import type { ModelDef } from '../../shared/providers';
import type { ProviderDriver } from './types';
import { ProviderAuthError, isAuthStatus, prettifyId } from './tool';

async function listModels(apiKey: string): Promise<ModelDef[]> {
  const resp = await fetch('https://api.anthropic.com/v1/models?limit=100', {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
  });
  if (!resp.ok) {
    const detail = (await resp.text().catch(() => '')).slice(0, 200);
    const message = `Anthropic /v1/models returned HTTP ${resp.status}: ${detail}`;
    if (isAuthStatus(resp.status)) throw new ProviderAuthError(message, resp.status);
    throw new Error(message);
  }
  const json = (await resp.json()) as {
    data?: { id: string; display_name?: string }[];
  };
  const items = json.data ?? [];
  return items
    .filter((m) => typeof m.id === 'string')
    .map((m) => ({
      id: m.id,
      label: m.display_name?.trim() || prettifyId(m.id),
    }));
}

export const anthropicDriver: ProviderDriver = { listModels };
