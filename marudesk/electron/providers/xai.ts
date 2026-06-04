import type { ModelDef } from '../../shared/providers';
import type { ProviderDriver } from './types';
import { ProviderAuthError, isAuthStatus, prettifyId } from './tool';

/**
 * xAI Grok live model catalog. The `/v1/models` endpoint takes a Bearer
 * credential — an API key or an OAuth access token both work. Agent turns use
 * the xAI Responses API provider in electron/agent/model.ts.
 * (docs/oauth-providers-design.md). Only reached when an API key is stored;
 * OAuth-only connections fall back to the static catalog (models.ts), like Anthropic.
 */
async function listModels(apiKey: string): Promise<ModelDef[]> {
  const resp = await fetch('https://api.x.ai/v1/models', {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!resp.ok) {
    const detail = (await resp.text().catch(() => '')).slice(0, 200);
    const message = `xAI /v1/models returned HTTP ${resp.status}: ${detail}`;
    if (isAuthStatus(resp.status)) throw new ProviderAuthError(message, resp.status);
    throw new Error(message);
  }
  const json = (await resp.json()) as { data?: { id?: unknown }[] };
  return (json.data ?? [])
    .filter((m): m is { id: string } => typeof m.id === 'string')
    .map((m) => ({ id: m.id, label: prettifyId(m.id) }));
}

export const xaiDriver: ProviderDriver = { listModels };
